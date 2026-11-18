import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranchReviewTool, OPEN_BRANCH_REVIEW_WAIT_MS } from "../../../../src/services/tab-tools-mcp/branch-review-tool.ts";
import type { TabOpenOutcome } from "../../../../src/services/tab-tools-mcp/tab-open-broker.ts";
import type { TabOpenAsk } from "../../../../src/shared/tab-open-protocol.ts";

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e" } });

/** A repository on `main` with one commit, then `feature` two files and +3 −1 ahead of it. */
function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "init");
  sh(dir, "checkout", "-qb", "feature");
  writeFileSync(join(dir, "a.txt"), "one\nTWO\n");
  writeFileSync(join(dir, "b.txt"), "x\ny\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "work");
}

let root: string;
let single: string;
let container: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "obr-"));
  single = join(root, "single");
  makeRepo(single);
  container = join(root, "container");
  makeRepo(join(container, "api"));
  makeRepo(join(container, "web"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const OPENED: TabOpenOutcome = { ok: true, result: { type: "tab_open_result", requestId: "r".repeat(16), opened: true } };

function setup(projectPath: string | null, outcome: TabOpenOutcome = OPENED) {
  const calls: Array<{ sessionId: string; req: TabOpenAsk; waitMs: number }> = [];
  const tool = createBranchReviewTool({
    request: async (sessionId, req, waitMs) => {
      calls.push({ sessionId, req, waitMs });
      return outcome;
    },
  });
  const binding = { sessionId: "s1", projectPath, projectName: projectPath ? "demo" : null };
  const run = async (args: Record<string, unknown> = {}) => {
    const result = (await tool(binding, args)) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: result.content[0]!.text, isError: result.isError === true };
  };
  return { calls, run };
}

describe("open_branch_review", () => {
  it("reviews the branch checked out against main, and says what the user is looking at", async () => {
    const { calls, run } = setup(single);
    const result = await run();
    expect(result.isError).toBe(false);
    expect(calls).toEqual([{
      sessionId: "s1", waitMs: OPEN_BRANCH_REVIEW_WAIT_MS,
      req: { tool: "open_branch_review", projectName: "demo", repo: null, base: "main", head: "feature" },
    }]);
    expect(result.text).toMatch(/^Opened Branch Review on the user's device: feature against main \(merge base [0-9a-f]{7}\)\.\n2 files changed, \+3 −1\.$/);
  });

  it("names the uncommitted changes the review leaves out", async () => {
    writeFileSync(join(single, "b.txt"), "x\nchanged\n");
    writeFileSync(join(single, "new.txt"), "untracked\n");
    try {
      const { text } = await setup(single).run();
      expect(text).toContain("2 files in the working tree have changes not committed to feature, which the review does not show.");
    } finally {
      sh(single, "checkout", "-q", "--", "b.txt");
      rmSync(join(single, "new.txt"));
    }
    // Reviewing a branch that is not checked out says nothing about the working tree.
    writeFileSync(join(single, "b.txt"), "dirty\n");
    try {
      const { text } = await setup(single).run({ base: "feature", head: "main" });
      expect(text).not.toContain("not committed");
    } finally {
      sh(single, "checkout", "-q", "--", "b.txt");
    }
  });

  it("refuses a ref that names nothing, or is not a ref at all, before any tab opens", async () => {
    const { calls, run } = setup(single);
    expect(await run({ head: "nope" })).toEqual({ isError: true, text: "No branch or commit is named nope." });
    expect((await run({ base: "--output=/tmp/x" })).isError).toBe(true);
    expect((await run({ base: "main..feature" })).isError).toBe(true);
    expect((await run({ head: 5 })).text).toBe("`head` must be a branch name.");
    expect(calls).toEqual([]);
  });

  it("asks which repository when the project folder holds several, and reviews the one named", async () => {
    const { calls, run } = setup(container);
    expect(await run()).toEqual({ isError: true, text: "The project folder holds several repositories; pass `repo`, one of: api, web." });
    expect((await run({ repo: "nowhere" })).text).toBe("nowhere is not one of the project's repositories. They are: api, web.");
    const result = await run({ repo: "web/" });
    expect(result.text).toStartWith("Opened Branch Review in web on the user's device: feature against main");
    expect(calls.map((c) => c.req)).toEqual([
      { tool: "open_branch_review", projectName: "demo", repo: join(container, "web"), base: "main", head: "feature" },
    ]);
    expect((await run({ repo: join(container, "api") })).isError).toBe(false);
  });

  it("asks for head on a detached HEAD, and for base when there is no main or master", async () => {
    const dir = join(root, "odd");
    makeRepo(dir);
    sh(dir, "branch", "-qm", "main", "trunk");
    const { run } = setup(dir);
    expect((await run()).text).toBe("This repository has no main or master branch; pass `base`, such as trunk.");
    expect((await run({ base: "trunk" })).isError).toBe(false);
    sh(dir, "checkout", "-q", "--detach");
    expect((await run({ base: "trunk" })).text).toBe("No branch is checked out (a detached HEAD); pass `head`.");
  });

  it("tells the AI how the user can open it when no device has the chat open", async () => {
    const { run } = setup(single, { ok: false, reason: "no-device", message: "No PPM window has this chat open, so nothing was shown." });
    const result = await run();
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Source Control → Branch Review, with main as the base and feature to review.");
  });

  it("needs a project", async () => {
    const { calls, run } = setup(null);
    expect((await run()).text).toBe("This chat is not in a PPM project, so there is no repository to review.");
    expect(calls).toEqual([]);
  });
});
