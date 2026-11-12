import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectToolHandlers, PROJECT_ROUTES } from "../../../../src/services/assistant-mcp/assistant-project-tools.ts";
import type { ProjectToolDeps } from "../../../../src/services/assistant-mcp/assistant-project-write-tools.ts";
import type { ApprovalAsk, ApprovalVerdict } from "../../../../src/services/assistant-mcp/assistant-approval-broker.ts";
import type { ToolContext } from "../../../../src/services/assistant-mcp/assistant-tool-family.ts";
import type { CallPpmRoute, RouteCallResult, RouteMethod } from "../../../../src/services/assistant-mcp/assistant-route-rules.ts";
import { checkRouteCall, isProjectListPath, ruleProblem } from "../../../../src/services/assistant-mcp/assistant-route-call.ts";
import { allowRoute } from "../../../../src/services/assistant-mcp/assistant-route-rules.ts";
import { PROJECT_REMOVE_TOOL, PROJECT_TOOLS, PROJECT_UPDATE_TOOL } from "../../../../src/shared/assistant-project-tool-names.ts";
import { PROJECT_TOOL_DEFINITIONS } from "../../../../src/services/assistant-mcp/assistant-project-tool-definitions.ts";

type Project = { name: string; path: string; color?: string };

interface Harness {
  ctx: ToolContext;
  projects: Project[];
  writes: string[];
  asks: ApprovalAsk[];
  home: string;
  folder: (name: string) => string;
  deps: ProjectToolDeps & { running: Set<string>; managers: Map<string, string> };
}

function harness(opts: { verdict?: ApprovalVerdict; onAsk?: (h: Harness) => void } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "ppm-project-tools-"));
  const home = join(root, "home");
  const folder = (name: string) => {
    const p = join(home, "code", name);
    mkdirSync(p, { recursive: true });
    return p;
  };
  const projects: Project[] = [{ name: "alpha", path: folder("alpha") }, { name: "beta", path: folder("beta") }];
  const writes: string[] = [];
  const asks: ApprovalAsk[] = [];
  // A small stand-in for the project routes, behind the family's real allowlist and gate.
  const callRoute = (async <T,>(method: RouteMethod, path: string, body?: Record<string, unknown>): Promise<RouteCallResult<T>> => {
    const checked = checkRouteCall(PROJECT_ROUTES, method, path, body, () => null);
    if (!checked.ok || !isProjectListPath(path)) throw new Error(`not allowed: ${method} ${path}`);
    if (method === "GET") return { status: 200, ok: true, data: structuredClone(projects) as T };
    writes.push(`${method} ${path} ${JSON.stringify(body ?? null)}`);
    const name = decodeURIComponent(path.split("/")[3]!);
    const p = projects.find((x) => x.name === name);
    if (!p) return { status: 404, ok: false, error: `Project not found: ${name}` };
    if (method === "DELETE") projects.splice(projects.indexOf(p), 1);
    else if (!path.endsWith("/color")) Object.assign(p, body);
    else if (body!.color) p.color = body!.color as string;
    else delete p.color;
    return { status: 200, ok: true, data: { ...p } as T };
  }) as CallPpmRoute;
  const running = new Set<string>();
  const managers = new Map<string, string>();
  const deps = {
    home, ppmDir: join(home, ".ppm"), running, managers,
    managerSession: async (path: string) => managers.get(path) ?? null,
    isRunning: (id: string) => running.has(id),
  };
  const h: Harness = {
    projects, writes, asks, home, folder, deps,
    ctx: {
      sessionId: "s1",
      callRoute,
      ask: async (ask) => {
        asks.push(ask);
        opts.onAsk?.(h);
        return opts.verdict ?? { verdict: "approved" };
      },
    },
  };
  return h;
}

const run = (h: Harness, tool: string, args: Record<string, unknown>) => createProjectToolHandlers(h.deps)[tool]!(h.ctx, args);
const textOf = (r: Record<string, unknown>) => ((r.content as Array<{ text: string }>)[0]!.text);

test("names, definitions, handlers and routes line up", () => {
  expect(PROJECT_TOOL_DEFINITIONS.map((d) => d.name)).toEqual([...PROJECT_TOOLS]);
  expect(Object.keys(createProjectToolHandlers())).toEqual([...PROJECT_TOOLS]);
  expect(PROJECT_ROUTES.map(ruleProblem)).toEqual(PROJECT_ROUTES.map(() => null));
  const update = PROJECT_TOOL_DEFINITIONS.find((d) => d.name === PROJECT_UPDATE_TOOL)!;
  const remove = PROJECT_TOOL_DEFINITIONS.find((d) => d.name === PROJECT_REMOVE_TOOL)!;
  expect(update.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
  expect(remove.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
});

describe("the project routes the family may reach", () => {
  test("only the list, one project and its colour; never the clone, the upload, the settings or a literal route", () => {
    expect(isProjectListPath("/api/projects")).toBe(true);
    expect(isProjectListPath("/api/projects/alpha")).toBe(true);
    expect(isProjectListPath("/api/projects/alpha/color")).toBe(true);
    for (const p of ["/api/projects/git/clone", "/api/projects/alpha/image", "/api/projects/alpha/settings",
      "/api/projects/reorder", "/api/projects/suggest-dirs", "/api/projects/", "/api/projectsx/a"]) {
      expect({ p, ok: isProjectListPath(p) }).toEqual({ p, ok: false });
    }
    expect(ruleProblem(allowRoute("POST", "/api/projects/git/clone"))).toContain("project list route");
    expect(ruleProblem(allowRoute("POST", "/api/projects/:name/image"))).toContain("project list route");
  });
});

describe("project_update", () => {
  test("renames after a card naming both names and the folder", async () => {
    const h = harness();
    const res = await run(h, PROJECT_UPDATE_TOOL, { project: "alpha", name: "gamma" });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(textOf(res))).toMatchObject({ outcome: "updated", name: "gamma" });
    const card = h.asks[0]!.summary;
    expect(card.headline).toBe('Rename project "alpha" to "gamma"');
    expect(card.facts).toEqual(expect.arrayContaining([
      { label: "Project", value: "alpha" }, { label: "Folder now", value: h.projects[0]!.path }, { label: "New name", value: "gamma" },
    ]));
    expect(card.warning).toBeUndefined();
    expect(h.writes).toEqual(['PATCH /api/projects/alpha {"name":"gamma"}']);
  });

  test("moves with the warning on the card, and sets the colour on the renamed project", async () => {
    const h = harness();
    const target = h.folder("alpha-v2");
    const res = await run(h, PROJECT_UPDATE_TOOL, { project: "alpha", name: "alpha2", path: target, color: "#AABBCC" });
    expect(res.isError).toBeUndefined();
    const card = h.asks[0]!.summary;
    expect(card.headline).toContain('Rename project "alpha" to "alpha2" and move it to');
    expect(card.facts).toEqual(expect.arrayContaining([{ label: "New folder", value: target, tone: "warning" }, { label: "Colour", value: "#aabbcc" }]));
    expect(card.warning).toContain("the old folder is left as it is");
    expect(h.writes).toEqual([
      `PATCH /api/projects/alpha ${JSON.stringify({ name: "alpha2", path: target })}`,
      'PATCH /api/projects/alpha2/color {"color":"#aabbcc"}',
    ]);
  });

  test("refuses, before asking, a move into the home folder's application data or onto another project's folder", async () => {
    const h = harness();
    const config = join(h.home, ".config", "google-chrome");
    mkdirSync(config, { recursive: true });
    expect(textOf(await run(h, PROJECT_UPDATE_TOOL, { project: "alpha", path: config }))).toContain(".config");
    expect(textOf(await run(h, PROJECT_UPDATE_TOOL, { project: "alpha", path: h.projects[1]!.path }))).toContain('already the project "beta"');
    expect(textOf(await run(h, PROJECT_UPDATE_TOOL, { project: "alpha", path: join(h.home, "nope") }))).toContain("no folder");
    expect(h.asks).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  test("refuses reserved and taken names, an empty change and the Assistant's own chats, before asking", async () => {
    const h = harness();
    for (const name of ["reorder", "__assistant__", "beta", "a/b"]) {
      expect((await run(h, PROJECT_UPDATE_TOOL, { project: "alpha", name })).isError).toBe(true);
    }
    expect(textOf(await run(h, PROJECT_UPDATE_TOOL, { project: "alpha" }))).toContain("Nothing to change");
    expect(textOf(await run(h, PROJECT_UPDATE_TOOL, { project: "__assistant__", name: "x" }))).toContain("not a project");
    expect(h.asks).toEqual([]);
  });

  test("changes nothing when the project was renamed while the card waited", async () => {
    const h = harness({ onAsk: (x) => { x.projects[0]!.name = "renamed"; } });
    const res = await run(h, PROJECT_UPDATE_TOOL, { project: "alpha", name: "gamma" });
    expect(textOf(res)).toContain("while the card waited");
    expect(h.writes).toEqual([]);
  });

  test("changes nothing when the new name was taken while the card waited", async () => {
    const h = harness({ onAsk: (x) => { x.projects[1]!.name = "gamma"; } });
    expect(textOf(await run(h, PROJECT_UPDATE_TOOL, { project: "alpha", name: "gamma" }))).toContain('already named "gamma"');
    expect(h.writes).toEqual([]);
  });

  test("waits while the project's manager chat runs a turn, and changes nothing on a decline", async () => {
    const busy = harness();
    busy.deps.managers.set(busy.projects[0]!.path, "m1");
    busy.deps.running.add("m1");
    expect(textOf(await run(busy, PROJECT_UPDATE_TOOL, { project: "alpha", name: "gamma" }))).toContain("manager chat");
    expect(busy.asks).toEqual([]);
    const declined = harness({ verdict: { verdict: "denied", reason: "no" } });
    expect(JSON.parse(textOf(await run(declined, PROJECT_UPDATE_TOOL, { project: "alpha", color: null }))).outcome).toBe("declined");
    expect(declined.writes).toEqual([]);
  });
});

describe("project_remove", () => {
  test("refuses the Assistant's own chats and never asks", async () => {
    const h = harness();
    const res = await run(h, PROJECT_REMOVE_TOOL, { project: "__assistant__" });
    expect(res.isError).toBe(true);
    expect(h.asks).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  test("removes after a card that says what goes and what stays", async () => {
    const h = harness();
    h.deps.managers.set(h.projects[0]!.path, "m1");
    const res = await run(h, PROJECT_REMOVE_TOOL, { project: "alpha" });
    expect(JSON.parse(textOf(res))).toMatchObject({ outcome: "removed", name: "alpha" });
    const card = h.asks[0]!.summary;
    expect(card.headline).toBe('Remove project "alpha" from PPM');
    expect(card.facts).toEqual(expect.arrayContaining([
      { label: "Folder", value: join(h.home, "code", "alpha") }, { label: "Git repository", value: "No" }, { label: "Manager chat", value: "Yes" },
    ]));
    expect(card.warning).toContain("Files on disk and chat transcripts stay");
    expect(card.warning).toContain("Jira watchers");
    expect(h.writes).toEqual(["DELETE /api/projects/alpha null"]);
    expect(h.projects.map((p) => p.name)).toEqual(["beta"]);
  });

  test("refuses while the manager chat runs, and removes nothing when the project moved while the card waited", async () => {
    const busy = harness();
    busy.deps.managers.set(busy.projects[0]!.path, "m1");
    busy.deps.running.add("m1");
    expect(textOf(await run(busy, PROJECT_REMOVE_TOOL, { project: "alpha" }))).toContain("manager chat");
    expect(busy.asks).toEqual([]);
    const moved = harness({ onAsk: (x) => { x.projects[0]!.path = x.folder("elsewhere"); } });
    expect(textOf(await run(moved, PROJECT_REMOVE_TOOL, { project: "alpha" }))).toContain("while the card waited");
    expect(moved.writes).toEqual([]);
  });
});
