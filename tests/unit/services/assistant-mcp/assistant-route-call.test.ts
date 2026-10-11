/**
 * The Assistant's tool families call PPM's own routes in-process, without `authMiddleware`. The
 * allowlist is therefore the whole boundary: only a declared method + path template (and its
 * declared query keys) reaches a router, each family reaches only its own declarations, and every
 * path a router would read differently from the template — dot segments, encoded separators,
 * double encoding, a second query, a repeated key — is refused before anything runs.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configService } from "../../../../src/services/config.service.ts";
import { onGitEvent } from "../../../../src/services/git-changes/git-events.ts";
import {
  checkRouteCall, createRouteCaller, internalRouteApp, ROUTE_NOT_ALLOWED, ruleProblem, type RouteApp,
} from "../../../../src/services/assistant-mcp/assistant-route-call.ts";
import { allowRoute, projectRoute, withQuery, type RouteRule } from "../../../../src/services/assistant-mcp/assistant-route-rules.ts";
import {
  callFamilyTool, familyToolHandler, routeCallerFor, toolFamilies, type FamilyHandler, type ToolFamily,
} from "../../../../src/services/assistant-mcp/assistant-tool-family.ts";
import { GIT_TOOL_HANDLERS } from "../../../../src/services/assistant-mcp/assistant-git-tools.ts";
import { ASSISTANT_TOOL_DEFINITIONS } from "../../../../src/services/assistant-mcp/assistant-mcp-tools.ts";
import { ASSISTANT_TOOLS } from "../../../../src/shared/assistant-tool-names.ts";
import { ASSISTANT_PROJECT_NAME } from "../../../../src/shared/assistant-project.ts";
import { noApprover } from "../../../../src/services/assistant-mcp/assistant-approval-broker.ts";
import { textResult } from "../../../../src/services/mcp-http-endpoint.ts";

const GIT_RULES: RouteRule[] = [
  allowRoute("POST", "/api/project/:project/git/stage", ["repo"]),
  allowRoute("GET", "/api/project/:project/git/changes", ["repo"]),
];
const TUNNEL_RULES: RouteRule[] = [allowRoute("DELETE", "/api/tunnels/:pid")];

/** A stand-in router that records what reached it. */
function recordingApp() {
  const seen: Array<{ url: string; method: string; body: string | null; type: string | null }> = [];
  const app: RouteApp = {
    request: async (url, init) => {
      seen.push({
        url, method: String(init.method),
        body: typeof init.body === "string" ? init.body : null,
        type: new Headers(init.headers).get("content-type"),
      });
      return Response.json({ ok: true, data: { reached: true } });
    },
  };
  return { seen, app: async () => app };
}

const onlyProject = (name: string) => (candidate: string) => (candidate === name ? null : `No registered project is named "${candidate}".`);

describe("route rules", () => {
  it("accepts literal templates with whole-segment placeholders", () => {
    for (const rule of [...GIT_RULES, ...TUNNEL_RULES, allowRoute("PATCH", "/api/schedules/:id"), allowRoute("GET", "/api/tunnel/named/status")]) {
      expect(ruleProblem(rule)).toBeNull();
    }
  });

  it("rejects anything that could match more than it says", () => {
    const bad: RouteRule[] = [
      { method: "HEAD" as never, path: "/api/tunnels", query: [] },
      allowRoute("GET", "/api/project/:project/git/.*"),
      allowRoute("GET", "/api/project/:project/git/../fs"),
      allowRoute("GET", "/api/project/:project/git/"),
      allowRoute("GET", "/api/project/:project/git//changes"),
      allowRoute("GET", "/api/project/myproject/git/changes"),
      allowRoute("GET", "/api/project/:project/git/changes", ["repo", "repo"]),
      allowRoute("GET", "/api/project/:project/git/changes", ["re po"]),
      allowRoute("GET", "/settings"),
      allowRoute("GET", "/api/tunnels/:pid?"),
    ];
    for (const rule of bad) expect({ rule: rule.path, problem: ruleProblem(rule) }).not.toMatchObject({ problem: null });
  });

  it("builds project paths the checker accepts, leaving out absent query values", () => {
    expect(projectRoute("my proj", "git/changes", { repo: "C:\\work\\a b", skip: undefined, max: null }))
      .toBe("/api/project/my%20proj/git/changes?repo=C%3A%5Cwork%5Ca+b");
    expect(withQuery("/api/schedules", {})).toBe("/api/schedules");
    const checked = checkRouteCall(GIT_RULES, "GET", projectRoute("my proj", "git/changes", { repo: "C:\\work\\a b" }), undefined, () => null);
    expect(checked.ok).toBe(true);
  });
});

describe("the allowlist", () => {
  it("passes a declared call to the router with a JSON body", async () => {
    const { seen, app } = recordingApp();
    const call = createRouteCaller(GIT_RULES, { app, isProject: onlyProject("proj") });
    const res = await call("POST", projectRoute("proj", "git/stage", { repo: "/abs/repo" }), { files: ["a.txt"] });
    expect(res).toEqual({ status: 200, ok: true, data: { reached: true } });
    expect(seen).toEqual([{
      url: "http://ppm.internal/api/project/proj/git/stage?repo=%2Fabs%2Frepo", method: "POST",
      body: JSON.stringify({ files: ["a.txt"] }), type: "application/json",
    }]);
    // A POST with no body still sends an empty object, which every route's `c.req.json()` can read.
    await call("POST", projectRoute("proj", "git/stage"));
    expect(seen[1]!.body).toBe("{}");
    await call("GET", projectRoute("proj", "git/changes"));
    expect(seen[2]).toMatchObject({ method: "GET", body: null, type: null });
  });

  it("refuses every undeclared route, method or shape without reaching a router", async () => {
    const { seen, app } = recordingApp();
    const call = createRouteCaller([...GIT_RULES, ...TUNNEL_RULES], { app, isProject: () => null });
    const refused: Array<[string, string, Record<string, unknown>?]> = [
      // Routes nobody declared.
      ["GET", "/api/fs/read?path=/etc/passwd"],
      ["GET", "/api/settings"],
      ["POST", "/api/project/proj/git/discard", { files: ["a"] }],
      ["POST", "/api/project/proj/chat/sessions", {}],
      // A declared path under another method.
      ["GET", "/api/project/proj/git/stage"],
      ["DELETE", "/api/project/proj/git/changes"],
      ["HEAD", "/api/project/proj/git/changes"],
      ["post", "/api/project/proj/git/stage", {}],
      ["OPTIONS", "/api/tunnels/12"],
      // Path traversal, raw and encoded.
      ["GET", "/api/project/proj/git/../../settings"],
      ["GET", "/api/project/proj/git/changes/.."],
      ["GET", "/api/project/../git/changes"],
      ["GET", "/api/project/proj/git/%2E%2E/changes"],
      ["GET", "/api/project/%2e%2e/git/changes"],
      ["GET", "/api/project/proj/./git/changes"],
      // Encoded separators and double encoding in a placeholder or a literal.
      ["POST", "/api/project/proj%2F..%2F..%2Fother/git/stage", {}],
      ["POST", "/api/project/proj%5C..%5Cother/git/stage", {}],
      ["POST", "/api/project/proj%252F..%252Fother/git/stage", {}],
      ["POST", "/api/project/proj%00/git/stage", {}],
      ["POST", "/api/project/proj/git/st%61ge", {}],
      ["POST", "/api/project/proj/git%2Fstage", {}],
      ["DELETE", "/api/tunnels/12%2F..%2F..%2Ffs"],
      ["POST", "/api/project/proj\\..\\x/git/stage", {}],
      // Not one path, or not this origin.
      ["DELETE", "//evil.example/api/tunnels/12"],
      ["DELETE", "http://evil.example/api/tunnels/12"],
      ["DELETE", "api/tunnels/12"],
      ["DELETE", "/api/tunnels/12/"],
      ["DELETE", "/api/tunnels//12"],
      ["DELETE", "/api/tunnels/12 "],
      ["DELETE", "/api/tunnels/12#frag"],
      // Query smuggling.
      ["DELETE", "/api/tunnels/12?force=1"],
      ["GET", "/api/project/proj/git/changes?path=/etc/passwd"],
      ["GET", "/api/project/proj/git/changes?repo=/a&repo=/b"],
      ["GET", "/api/project/proj/git/changes?repo=/a?x=/api/fs"],
      ["GET", "/api/project/proj/git/changes?"],
      ["GET", "/api/project/proj/git/changes?repo=%2Fa%0D%0AX-Injected:1"],
      ["GET", "/api/project/proj/git/changes?Repo=/a"],
      ["GET", "/api/project/proj/git/changes?repo=/a&__proto__=x"],
      ["GET", "/api/project/proj/git/changes;repo=/a"],
      // Bodies a route was not meant to get.
      ["GET", "/api/project/proj/git/changes", {}],
      ["DELETE", "/api/tunnels/12", {}],
      ["POST", "/api/project/proj/git/stage", ["a"] as never],
      ["POST", "/api/project/proj/git/stage", new Map() as never],
    ];
    for (const [method, path, body] of refused) {
      const res = await call(method as never, path, body);
      expect({ method, path, status: res.status, ok: res.ok, code: res.code }).toEqual({ method, path, status: 403, ok: false, code: ROUTE_NOT_ALLOWED });
    }
    expect(seen).toHaveLength(0);
  });

  it("refuses a body too large or not serialisable", async () => {
    const { seen, app } = recordingApp();
    const call = createRouteCaller(GIT_RULES, { app, isProject: () => null });
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect((await call("POST", "/api/project/p/git/stage", loop)).code).toBe(ROUTE_NOT_ALLOWED);
    expect((await call("POST", "/api/project/p/git/stage", { files: ["x".repeat(1024 * 1024)] })).code).toBe(ROUTE_NOT_ALLOWED);
    expect(seen).toHaveLength(0);
  });

  it("only lets a registered project's exact name address a project route", async () => {
    const { seen, app } = recordingApp();
    const call = createRouteCaller(GIT_RULES, { app, isProject: onlyProject("proj") });
    for (const name of ["other", "PROJ", "proj ", ASSISTANT_PROJECT_NAME, "C:"]) {
      const res = await call("GET", projectRoute(name, "git/changes"));
      expect({ name, status: res.status, code: res.code }).toEqual({ name, status: 404, code: "project_not_found" });
    }
    expect(seen).toHaveLength(0);
  });

  it("drops a rule it cannot enforce instead of widening the family", async () => {
    const { seen, app } = recordingApp();
    const call = createRouteCaller([allowRoute("GET", "/api/project/:project/git/.*")], { app, isProject: () => null });
    expect((await call("GET", "/api/project/p/git/.*")).code).toBe(ROUTE_NOT_ALLOWED);
    expect(seen).toHaveLength(0);
  });

  it("is per family: one family's caller cannot reach another family's routes", async () => {
    const { seen, app } = recordingApp();
    const git = createRouteCaller(GIT_RULES, { app, isProject: () => null });
    const tunnel = createRouteCaller(TUNNEL_RULES, { app, isProject: () => null });
    expect((await tunnel("POST", "/api/project/p/git/stage", {})).code).toBe(ROUTE_NOT_ALLOWED);
    expect((await git("DELETE", "/api/tunnels/12")).code).toBe(ROUTE_NOT_ALLOWED);
    expect(seen).toHaveLength(0);
    expect((await git("POST", "/api/project/p/git/stage", {})).ok).toBe(true);
    expect((await tunnel("DELETE", "/api/tunnels/12")).ok).toBe(true);
    expect(seen.map((s) => s.url)).toEqual(["http://ppm.internal/api/project/p/git/stage", "http://ppm.internal/api/tunnels/12"]);
  });
});

describe("the family dispatcher", () => {
  it("hands each family's handler its own family's caller, and nothing for any other name", async () => {
    const probe: FamilyHandler = async (ctx) => {
      expect(ctx.callRoute).toBe(routeCallerFor("git"));
      expect(ctx.sessionId).toBe("s-1");
      return textResult("probed");
    };
    const handlers = GIT_TOOL_HANDLERS as Record<string, FamilyHandler>;
    handlers.__route_call_probe__ = probe;
    try {
      const asked: ToolFamily[] = [];
      const result = await callFamilyTool("__route_call_probe__", { sessionId: "s-1", ask: noApprover }, {}, (family) => {
        asked.push(family);
        return routeCallerFor(family);
      });
      expect(result).toEqual(textResult("probed"));
      expect(asked).toEqual(["git"]);
    } finally {
      delete handlers.__route_call_probe__;
    }
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "nope", "projects_list"]) {
      expect(familyToolHandler(name)).toBeNull();
      expect(callFamilyTool(name, { sessionId: "s-1", ask: noApprover }, {})).toBeNull();
    }
    expect(routeCallerFor("git")).not.toBe(routeCallerFor("schedule"));
    expect(routeCallerFor("schedule")).not.toBe(routeCallerFor("tunnel"));
  });

  it("keeps every family's names, definitions, handlers and routes consistent", () => {
    const definitions = new Map(ASSISTANT_TOOL_DEFINITIONS.map((d) => [d.name as string, d]));
    const seen = new Set<string>();
    for (const { family, tools, handlers, routes } of toolFamilies()) {
      for (const rule of routes) expect({ family, path: rule.path, problem: ruleProblem(rule) }).toEqual({ family, path: rule.path, problem: null });
      expect({ family, handlers: Object.keys(handlers).sort() }).toEqual({ family, handlers: [...tools].sort() });
      for (const name of tools) {
        expect(seen.has(name)).toBe(false);
        seen.add(name);
        expect((ASSISTANT_TOOLS as readonly string[]).includes(name)).toBe(true);
        const definition = definitions.get(name) as { annotations?: { readOnlyHint?: unknown } } | undefined;
        expect(typeof definition?.annotations?.readOnlyHint).toBe("boolean");
      }
    }
  });
});

describe("the internal app", () => {
  let projectDir: string;
  let savedProjects: unknown;

  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ppm-route-call-"));
    const git = Bun.spawnSync(["git", "init", "-q"], { cwd: projectDir });
    if (git.exitCode !== 0) throw new Error(`git init failed: ${git.stderr.toString()}`);
    writeFileSync(join(projectDir, "a.txt"), "hello\n");
    savedProjects = configService.get("projects");
    configService.set("projects", [{ name: "route-call", path: projectDir }]);
  });

  afterAll(() => {
    configService.set("projects", savedProjects as never);
    rmSync(projectDir, { recursive: true, force: true });
  });

  let off: (() => void) | null = null;
  afterEach(() => {
    off?.();
    off = null;
  });

  it("loads lazily once the server's whole module graph is in place", async () => {
    // Importing the server first is the order a running PPM has: the routers then come from an
    // already-evaluated graph, which a static import from this module would have closed into a cycle.
    const server = await import("../../../../src/server/index.ts");
    expect(server.app).toBeDefined();
    const app = await internalRouteApp();
    expect(await internalRouteApp()).toBe(app);
  });

  it("runs a real git route, which broadcasts git:changed as it does for the UI", async () => {
    const events: Array<{ type: string; projectName?: string }> = [];
    off = onGitEvent((e) => events.push(e as never));
    const call = createRouteCaller(GIT_RULES);
    const staged = await call("POST", projectRoute("route-call", "git/stage"), { files: ["a.txt"] });
    expect(staged).toMatchObject({ status: 200, ok: true, data: { staged: ["a.txt"] } });
    expect(events).toEqual([expect.objectContaining({ type: "git:changed", projectName: "route-call" })]);
    const changes = await call<{ files: Array<{ path: string }> }>("GET", projectRoute("route-call", "git/changes"));
    expect(changes.ok).toBe(true);
    expect(JSON.stringify(changes.data)).toContain("a.txt");
  });

  it("still answers with the routers' own refusals", async () => {
    const call = createRouteCaller(GIT_RULES, { isProject: () => null });
    // The project-scoped router refuses an unregistered name and the Assistant's own project.
    expect((await call("GET", projectRoute("not-registered", "git/changes"))).status).toBe(404);
    expect((await call("GET", projectRoute(ASSISTANT_PROJECT_NAME, "git/changes"))).status).toBe(404);
    // And the git router refuses a repository outside the project.
    const outside = await call("GET", projectRoute("route-call", "git/changes", { repo: tmpdir() }));
    expect(outside).toMatchObject({ status: 400, ok: false, error: "repo is outside the project" });
  });

  it("mounts none of the server's other routers, whatever a rule says", async () => {
    const call = createRouteCaller([
      allowRoute("GET", "/api/settings"), allowRoute("GET", "/api/fs/list", ["path"]), allowRoute("GET", "/api/health"),
    ]);
    for (const path of ["/api/settings", "/api/fs/list?path=%2F", "/api/health"]) {
      expect({ path, status: (await call("GET", path)).status }).toEqual({ path, status: 404 });
    }
  });
});
