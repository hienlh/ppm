import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { writeFileSync } from "fs";
import { GitService } from "../../../src/services/git.service.ts";
import { createTempGitRepo, cleanupDir } from "../../setup.ts";

let repoDir: string;
const svc = new GitService();

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
});

afterEach(() => {
  cleanupDir(repoDir);
});

describe("GitService.status()", () => {
  test("returns current branch for clean repo", async () => {
    const status = await svc.status(repoDir);
    expect(typeof status.branch).toBe("string");
    expect(status.branch.length).toBeGreaterThan(0);
  });

  test("shows untracked file as added/unstaged", async () => {
    writeFileSync(join(repoDir, "new.txt"), "content");
    const status = await svc.status(repoDir);
    const match = status.files.find((f) => f.path.includes("new.txt"));
    expect(match).toBeDefined();
    expect(match?.staged).toBe(false);
  });

  test("shows staged file", async () => {
    writeFileSync(join(repoDir, "staged.txt"), "data");
    await gitRun(repoDir, "add", "staged.txt");
    const status = await svc.status(repoDir);
    const match = status.files.find((f) => f.path.includes("staged.txt") && f.staged);
    expect(match).toBeDefined();
  });

  test("returns ahead/behind counts", async () => {
    const status = await svc.status(repoDir);
    expect(typeof status.ahead).toBe("number");
    expect(typeof status.behind).toBe("number");
  });
});

describe("GitService.branches()", () => {
  test("returns at least one branch", async () => {
    const branches = await svc.branches(repoDir);
    expect(branches.length).toBeGreaterThan(0);
  });

  test("has a current branch", async () => {
    const branches = await svc.branches(repoDir);
    const current = branches.find((b) => b.current);
    expect(current).toBeDefined();
  });

  test("new branch appears in list", async () => {
    await gitRun(repoDir, "checkout", "-b", "feature-x");
    const branches = await svc.branches(repoDir);
    const names = branches.map((b) => b.name);
    expect(names).toContain("feature-x");
  });

  test("branch has commitHash", async () => {
    const branches = await svc.branches(repoDir);
    for (const b of branches) {
      expect(b.commitHash.length).toBeGreaterThan(0);
    }
  });
});

describe("GitService.graphData()", () => {
  test("returns commits array with at least one entry", async () => {
    const data = await svc.graphData(repoDir);
    expect(data.commits.length).toBeGreaterThan(0);
  });

  test("commit has required fields", async () => {
    const data = await svc.graphData(repoDir);
    const c = data.commits[0];
    expect(c).toBeDefined();
    expect(typeof c!.hash).toBe("string");
    expect(typeof c!.subject).toBe("string");
    expect(typeof c!.authorName).toBe("string");
  });

  test("returns branches alongside commits", async () => {
    const data = await svc.graphData(repoDir);
    expect(Array.isArray(data.branches)).toBe(true);
  });

  test("multiple commits are captured", async () => {
    writeFileSync(join(repoDir, "second.txt"), "second");
    await gitRun(repoDir, "add", ".");
    await gitRun(repoDir, "commit", "-m", "second commit");
    const data = await svc.graphData(repoDir);
    expect(data.commits.length).toBeGreaterThanOrEqual(2);
  });
});

describe("GitService.stage() / unstage()", () => {
  test("stage adds file to index", async () => {
    writeFileSync(join(repoDir, "to-stage.txt"), "x");
    await svc.stage(repoDir, ["to-stage.txt"]);
    const status = await svc.status(repoDir);
    const staged = status.files.find((f) => f.path.includes("to-stage.txt") && f.staged);
    expect(staged).toBeDefined();
  });

  test("unstage removes file from index", async () => {
    writeFileSync(join(repoDir, "unstage-me.txt"), "x");
    await svc.stage(repoDir, ["unstage-me.txt"]);
    await svc.unstage(repoDir, ["unstage-me.txt"]);
    const status = await svc.status(repoDir);
    const staged = status.files.find((f) => f.path.includes("unstage-me.txt") && f.staged);
    expect(staged).toBeUndefined();
  });
});

describe("GitService.commit()", () => {
  test("returns commit hash after commit", async () => {
    writeFileSync(join(repoDir, "commit-me.txt"), "data");
    await gitRun(repoDir, "add", "commit-me.txt");
    const hash = await svc.commit(repoDir, "test commit");
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });
});
