/**
 * `?repo=` scopes a git route to one repository inside the project.
 *
 * A workspace folder is often a container whose children are the repositories,
 * so the project path and the git root are different directories. The
 * parameter is resolved once in a middleware and replaces `projectPath`, which
 * every handler already reads.
 *
 * The validation is the part worth testing. A bad value must be a 400, never a
 * fallback to the project root: falling back runs the command one directory up
 * and answers with *a* history — the wrong one — which is indistinguishable
 * from a working feature until somebody acts on it.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitRoutes } from "../../../src/server/routes/git.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

let project: string;
let outside: string;

function createApp(projectPath: string) {
  const app = new Hono<Env>();
  app.use("/*", async (c, next) => {
    c.set("projectPath", projectPath);
    c.set("projectName", "container");
    await next();
  });
  app.route("/git", gitRoutes);
  return app;
}

async function repos(query = ""): Promise<{ status: number; body: any }> {
  const res = await createApp(project).request(`/git/repos${query}`);
  return { status: res.status, body: await res.json() };
}

beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), "ppm-scope-"));
  mkdirSync(join(project, "frontend", ".git"), { recursive: true });
  mkdirSync(join(project, "backend", ".git"), { recursive: true });
  mkdirSync(join(project, "docs"), { recursive: true });
  outside = mkdtempSync(join(tmpdir(), "ppm-outside-"));
  mkdirSync(join(outside, ".git"), { recursive: true });
});

afterAll(() => {
  rmSync(project, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("GET /git/repos", () => {
  it("lists the repositories under a project that is not one itself", async () => {
    const { status, body } = await repos();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.rootIsRepo).toBe(false);
    expect(body.data.repos.map((r: { relative: string }) => r.relative)).toEqual(["backend", "frontend"]);
  });
});

describe("the ?repo= scope guard", () => {
  it("scopes to a repository inside the project", async () => {
    const { status, body } = await repos(`?repo=${encodeURIComponent(join(project, "frontend"))}`);
    expect(status).toBe(200);
    expect(body.data.rootIsRepo).toBe(true);
    expect(body.data.repos[0].path).toBe(join(project, "frontend"));
  });

  it("refuses a repository outside the project", async () => {
    // A real repository, just not this project's — the parameter is not a way
    // to read any checkout on the host through a project you do have.
    const { status, body } = await repos(`?repo=${encodeURIComponent(outside)}`);
    expect(status).toBe(400);
    expect(body.error).toContain("outside the project");
  });

  it("refuses a traversal that resolves out of the project", async () => {
    const escape = join(project, "frontend", "..", "..");
    const { status, body } = await repos(`?repo=${encodeURIComponent(escape)}`);
    expect(status).toBe(400);
    expect(body.error).toContain("outside the project");
  });

  it("refuses a directory inside the project that is not a repository", async () => {
    const { status, body } = await repos(`?repo=${encodeURIComponent(join(project, "docs"))}`);
    expect(status).toBe(400);
    expect(body.error).toContain("not a git repository");
  });

  it("refuses a sibling whose path merely starts with the project's", async () => {
    // `/tmp/ppm-scope-abc` must not accept `/tmp/ppm-scope-abc-evil`: the
    // containment test has to be on a path separator, not on a prefix.
    const sibling = `${project}-evil`;
    mkdirSync(join(sibling, ".git"), { recursive: true });
    try {
      const { status, body } = await repos(`?repo=${encodeURIComponent(sibling)}`);
      expect(status).toBe(400);
      expect(body.error).toContain("outside the project");
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("leaves the project path alone when the parameter is absent", async () => {
    const { body } = await repos("");
    expect(body.data.root).toBe(project);
  });
});
