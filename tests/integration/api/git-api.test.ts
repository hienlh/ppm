import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { writeFileSync } from "fs";
import { buildTestApp, createTempGitRepo, cleanupDir } from "../../setup.ts";
import { configService } from "../../../src/services/config.service.ts";
import type { Hono } from "hono";

let repoDir: string;
let app: Hono;

async function gitRun(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
}

beforeEach(async () => {
  repoDir = await createTempGitRepo({ "README.md": "# Hello\n" });
  // Git routes use the global configService — inject project directly
  (configService as unknown as { config: { projects: { path: string; name: string }[] } })
    .config.projects = [{ path: repoDir, name: "test-repo" }];
  app = buildTestApp({ projects: [{ path: repoDir, name: "test-repo" }] });
});

afterEach(() => {
  // Restore global configService projects
  (configService as unknown as { config: { projects: unknown[] } }).config.projects = [];
  cleanupDir(repoDir);
});

describe("GET /api/git/status/:project", () => {
  test("returns git status for clean repo", async () => {
    const encoded = encodeURIComponent(repoDir);
    const res = await app.request(`/api/git/status/${encoded}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; data: { branch: string; files: unknown[] } };
    expect(body.ok).toBe(true);
    expect(typeof body.data.branch).toBe("string");
    expect(Array.isArray(body.data.files)).toBe(true);
  });

  test("shows untracked files in status", async () => {
    writeFileSync(join(repoDir, "new.txt"), "content");
    const encoded = encodeURIComponent(repoDir);
    const res = await app.request(`/api/git/status/${encoded}`);
    const body = await res.json() as { ok: boolean; data: { files: { path: string }[] } };
    const found = body.data.files.some((f) => f.path.includes("new.txt"));
    expect(found).toBe(true);
  });

  test("returns 500 for unregistered project path", async () => {
    const encoded = encodeURIComponent("/tmp/not-a-git-repo");
    const res = await app.request(`/api/git/status/${encoded}`);
    expect(res.status).toBe(500);
  });
});

describe("GET /api/git/branches/:project", () => {
  test("returns branch list", async () => {
    const encoded = encodeURIComponent(repoDir);
    const res = await app.request(`/api/git/branches/${encoded}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; data: { name: string; current: boolean }[] };
    expect(body.ok).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
  });

  test("has a current branch", async () => {
    const encoded = encodeURIComponent(repoDir);
    const res = await app.request(`/api/git/branches/${encoded}`);
    const body = await res.json() as { ok: boolean; data: { current: boolean }[] };
    expect(body.data.some((b) => b.current)).toBe(true);
  });
});

describe("POST /api/git/stage", () => {
  test("stages a file", async () => {
    writeFileSync(join(repoDir, "stage-me.txt"), "data");
    const res = await app.request("/api/git/stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: repoDir, files: ["stage-me.txt"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("returns 500 for unregistered project", async () => {
    const res = await app.request("/api/git/stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "/tmp/ghost", files: ["x.txt"] }),
    });
    expect(res.status).toBe(500);
  });
});

describe("POST /api/git/commit", () => {
  test("commits staged files and returns hash", async () => {
    writeFileSync(join(repoDir, "commit-me.txt"), "hello");
    await gitRun(repoDir, "add", "commit-me.txt");
    const res = await app.request("/api/git/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: repoDir, message: "test commit via api" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; data: { hash: string } };
    expect(body.ok).toBe(true);
    expect(typeof body.data.hash).toBe("string");
  });

  test("returns 500 for unregistered project", async () => {
    const res = await app.request("/api/git/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "/tmp/ghost", message: "oops" }),
    });
    expect(res.status).toBe(500);
  });
});

describe("GET /api/git/graph/:project", () => {
  test("returns commit graph data", async () => {
    const encoded = encodeURIComponent(repoDir);
    const res = await app.request(`/api/git/graph/${encoded}`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      data: { commits: unknown[]; branches: unknown[] };
    };
    expect(body.ok).toBe(true);
    expect(body.data.commits.length).toBeGreaterThan(0);
    expect(Array.isArray(body.data.branches)).toBe(true);
  });
});
