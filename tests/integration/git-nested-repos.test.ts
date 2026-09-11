/**
 * A workspace folder that is not a repository, whose children are.
 *
 * The unit tests cover the validation and the path arithmetic; this one runs
 * real `git` against real repositories through the real routes, because the
 * failure this feature fixes is a *runtime* one: `simple-git` in a directory
 * with no `.git` does not answer "wrong directory", it answers with an error
 * whose wording the UI turns into "not a git repository" — and the fixed
 * version has to answer with the actual history instead.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitRoutes } from "../../src/server/routes/git.ts";
import { discoverGitRepos } from "../../src/services/git-repos/git-repo-discovery.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

let workspace: string;
let frontend: string;
let backend: string;

function app() {
  const a = new Hono<Env>();
  a.use("/*", async (c, next) => {
    c.set("projectPath", workspace);
    c.set("projectName", "workspace");
    await next();
  });
  a.route("/git", gitRoutes);
  return a;
}

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await app().request(path);
  return { status: res.status, body: await res.json() };
}

function git(cwd: string, args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
}

function makeRepo(path: string, file: string, subject: string): void {
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-q", "-b", "main"]);
  writeFileSync(join(path, file), "one\ntwo\nthree\n");
  git(path, ["add", "."]);
  git(path, ["commit", "-q", "-m", subject]);
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "ppm-nested-"));
  frontend = join(workspace, "frontend");
  backend = join(workspace, "backend");
  makeRepo(frontend, "app.ts", "frontend: first commit");
  makeRepo(backend, "main.go", "backend: first commit");
  // A plain directory alongside them, to prove discovery is not just listing
  // children.
  mkdirSync(join(workspace, "docs"), { recursive: true });
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("a container workspace", () => {
  it("is not a repository itself, and git says so without the scope", async () => {
    // The state the user reported: every git surface asking about the
    // workspace folder gets an error, so the whole feature looks broken.
    expect(discoverGitRepos(workspace).rootIsRepo).toBe(false);
    const { body } = await get("/git/status");
    expect(body.ok).toBe(false);
  });

  it("lists both repositories, and not the plain directory", async () => {
    const { status, body } = await get("/git/repos");
    expect(status).toBe(200);
    expect(body.data.rootIsRepo).toBe(false);
    expect(body.data.repos.map((r: { relative: string }) => r.relative)).toEqual([
      "backend",
      "frontend",
    ]);
  });

  it("answers with the chosen repository's own status", async () => {
    writeFileSync(join(frontend, "app.ts"), "one\ntwo\nthree\nfour\n");
    const { status, body } = await get(`/git/status?repo=${encodeURIComponent(frontend)}`);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    // Repository-relative, which is why the tree decorations have to be
    // rebased before they can match a project-relative path.
    expect(body.data.unstaged.map((f: { path: string }) => f.path)).toEqual(["app.ts"]);
    expect(body.data.current).toBe("main");
  });

  it("answers with the chosen repository's own history", async () => {
    const front = await get(`/git/graph?repo=${encodeURIComponent(frontend)}&max=10`);
    const back = await get(`/git/graph?repo=${encodeURIComponent(backend)}&max=10`);
    expect(front.body.data.commits[0].subject).toBe("frontend: first commit");
    expect(back.body.data.commits[0].subject).toBe("backend: first commit");
    // Two repositories with no relationship: neither history may leak into the
    // other, which is the thing a fallback to the workspace folder would do.
    expect(front.body.data.commits[0].hash).not.toBe(back.body.data.commits[0].hash);
  });

  it("blames a file inside the chosen repository", async () => {
    const path = encodeURIComponent("main.go");
    const { status, body } = await get(
      `/git/blame?repo=${encodeURIComponent(backend)}&path=${path}`,
    );
    expect(status).toBe(200);
    expect(body.data.lines).toHaveLength(3);
    const first = body.data.commits[body.data.lines[0].hash];
    expect(first.summary).toBe("backend: first commit");
  });

  it("refuses a repository outside the project", async () => {
    // The parameter names a directory to run git in, so it is the one thing
    // here that has to be validated rather than trusted.
    const { status, body } = await get(`/git/status?repo=${encodeURIComponent(tmpdir())}`);
    expect(status).toBe(400);
    expect(body.error).toContain("outside the project");
  });
});
