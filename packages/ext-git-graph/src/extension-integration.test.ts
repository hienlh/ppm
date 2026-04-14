import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

/**
 * Integration tests for git-graph extension.
 * Uses real git repositories to test git data fetching and parsing.
 */

let testRepoDir: string;

async function spawnGit(args: string[], cwd: string) {
  const env = {
    GIT_AUTHOR_NAME: "Test Author",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test Committer",
    GIT_COMMITTER_EMAIL: "committer@example.com",
  };

  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

async function initGitRepo(repoPath: string, withRemote = false) {
  const env = {
    GIT_AUTHOR_NAME: "Test Author",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test Committer",
    GIT_COMMITTER_EMAIL: "committer@example.com",
  };

  // Initialize repo
  await Bun.spawn(["git", "init"], { cwd: repoPath, env, stdout: "pipe" }).exited;

  // Create initial commit
  writeFileSync(join(repoPath, "README.md"), "# Test Repo\n");
  await Bun.spawn(["git", "add", "README.md"], { cwd: repoPath, env }).exited;
  await Bun.spawn(["git", "commit", "-m", "Initial commit"], { cwd: repoPath, env }).exited;

  // Create a branch
  await Bun.spawn(["git", "checkout", "-b", "develop"], { cwd: repoPath, env }).exited;
  writeFileSync(join(repoPath, "feature.txt"), "Feature content\n");
  await Bun.spawn(["git", "add", "feature.txt"], { cwd: repoPath, env }).exited;
  await Bun.spawn(["git", "commit", "-m", "Add feature"], { cwd: repoPath, env }).exited;

  // Create a tag
  await Bun.spawn(["git", "tag", "v1.0.0"], { cwd: repoPath, env }).exited;

  // Back to main
  await Bun.spawn(["git", "checkout", "main"], { cwd: repoPath, env }).exited;

  if (withRemote) {
    // Create a bare repo to act as remote
    const remoteDir = join(tmpdir(), `remote-${Date.now()}`);
    await Bun.spawn(["git", "init", "--bare"], { cwd: remoteDir, env }).exited;
    await Bun.spawn(["git", "remote", "add", "origin", remoteDir], { cwd: repoPath, env }).exited;
  }
}

describe("git-graph extension: integration tests", () => {
  beforeEach(() => {
    testRepoDir = mkdtempSync(resolve(tmpdir(), "ppm-git-graph-"));
  });

  afterEach(() => {
    try {
      rmSync(testRepoDir, { recursive: true, force: true });
    } catch {}
  });

  it("fetches branches from real git repo", async () => {
    await initGitRepo(testRepoDir);

    const result = await spawnGit(
      ["branch", "-a", "--format=%(refname:short)|%(objectname:short)|%(HEAD)"],
      testRepoDir
    );

    const lines = result.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    // Should have at least main and develop
    const branches = lines.map((line) => line.split("|")[0]);
    expect(branches).toContain("main");
    expect(branches).toContain("develop");
  });

  it("fetches tags from real git repo", async () => {
    await initGitRepo(testRepoDir);

    const result = await spawnGit(
      ["tag", "-l", "--format=%(refname:short)|%(objectname:short)"],
      testRepoDir
    );

    const lines = result.stdout.trim().split("\n").filter(Boolean);
    const tags = lines.map((line) => line.split("|")[0]);
    expect(tags).toContain("v1.0.0");
  });

  it("fetches git log with custom format", async () => {
    await initGitRepo(testRepoDir);

    const result = await spawnGit(
      [
        "log",
        `--format=%H%n%P%n%an%n%ae%n%at%n%cn%n%ce%n%ct%n%D%n%s%n<END_COMMIT>`,
        "--topo-order",
        "--all",
      ],
      testRepoDir
    );

    expect(result.stdout).toContain("<END_COMMIT>");
    const commits = result.stdout.split("<END_COMMIT>").filter((b) => b.trim());
    expect(commits.length).toBeGreaterThanOrEqual(2); // At least 2 commits
  });

  it("gets current branch name", async () => {
    await initGitRepo(testRepoDir);
    await spawnGit(["checkout", "main"], testRepoDir);

    const result = await spawnGit(["rev-parse", "--abbrev-ref", "HEAD"], testRepoDir);

    expect(result.stdout.trim()).toBe("main");
  });

  it("gets HEAD commit hash", async () => {
    await initGitRepo(testRepoDir);

    const result = await spawnGit(["rev-parse", "HEAD"], testRepoDir);

    const hash = result.stdout.trim();
    expect(hash).toMatch(/^[0-9a-f]{40}$/); // Valid SHA-1
  });

  it("handles repo with no commits gracefully", async () => {
    // Initialize but don't create commits
    await Bun.spawn(["git", "init"], { cwd: testRepoDir, stdout: "pipe" }).exited;

    const result = await spawnGit(["log", "--format=%H"], testRepoDir);
    expect(result.exitCode).not.toBe(0); // Will fail with no commits
  });

  it("parses commit details with show --stat", async () => {
    await initGitRepo(testRepoDir);

    // Get latest commit hash
    const hashResult = await spawnGit(["rev-parse", "HEAD"], testRepoDir);
    const hash = hashResult.stdout.trim();

    const result = await spawnGit(
      [
        "show",
        "--stat",
        `--format=%H%n%P%n%an%n%ae%n%at%n%cn%n%ce%n%ct%n%B%n<END_MSG>`,
        hash,
      ],
      testRepoDir
    );

    expect(result.stdout).toContain("<END_MSG>");
    expect(result.stdout).toContain(hash);
  });

  it("fetches stash list from repo", async () => {
    await initGitRepo(testRepoDir);

    // Create an unstaged change
    writeFileSync(join(testRepoDir, "test.txt"), "test content");
    await spawnGit(["add", "test.txt"], testRepoDir);
    await spawnGit(["stash", "push", "-m", "Test stash"], testRepoDir);

    const result = await spawnGit(
      ["stash", "list", "--format=%gd|%H|%s"],
      testRepoDir
    );

    expect(result.stdout).toContain("stash@{0}");
    expect(result.stdout).toContain("Test stash");
  });

  it("handles git operations with special characters in message", async () => {
    await initGitRepo(testRepoDir);

    writeFileSync(join(testRepoDir, "special.txt"), "content with special chars");
    await spawnGit(["add", "special.txt"], testRepoDir);
    await spawnGit(
      ["commit", "-m", "Fix: issue #123 & test 'quotes' \"double\""],
      testRepoDir
    );

    const result = await spawnGit(["log", "--oneline", "-1"], testRepoDir);

    expect(result.stdout).toContain("issue #123");
  });

  it("respects skip parameter in git log", async () => {
    await initGitRepo(testRepoDir);

    // Create 3 additional commits
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(testRepoDir, `file${i}.txt`), `content ${i}`);
      await spawnGit(["add", "."], testRepoDir);
      await spawnGit(["commit", "-m", `Commit ${i}`], testRepoDir);
    }

    const resultAll = await spawnGit(
      ["log", "--format=%H", "--all"],
      testRepoDir
    );
    const allCommits = resultAll.stdout.trim().split("\n").length;

    const resultSkip2 = await spawnGit(
      ["log", "--format=%H", "--skip=2", "--all"],
      testRepoDir
    );
    const skippedCommits = resultSkip2.stdout.trim().split("\n").filter(Boolean).length;

    expect(skippedCommits).toBeLessThan(allCommits);
  });
});
