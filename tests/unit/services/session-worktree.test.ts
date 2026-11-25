/**
 * Chats in a worktree of their own: which cwd counts as one of the project's worktrees, the record
 * PPM keeps, the line that keeps worktrees out of Source Control, and the ownership check that
 * finds such a chat's transcript under the worktree's slug.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { _setClaudeProjectsRoot } from "../../../src/services/agent-transcript/claude-projects-root.ts";
import { assertSessionInProject } from "../../../src/services/agent-transcript/session-ownership.ts";
import {
  excludeWorktreesFromGit, getSessionWorktree, getSessionWorktrees, recordSessionWorktree, worktreeOfCwd,
} from "../../../src/services/session-worktree.service.ts";
import { newWorktreeName, WORKTREE_NAME_RE } from "../../../src/shared/session-worktree.ts";

const PROJECT = "/workspace/project-a";
const SID = "aaaaaaaa-1111-2222-3333-444444444444";
const slugOf = (p: string) => p.replace(/[/\\:.]/g, "-");

describe("worktreeOfCwd", () => {
  it("names a worktree directly under the project's .claude/worktrees, and nothing else", () => {
    expect(worktreeOfCwd(PROJECT, PROJECT + "/.claude/worktrees/chat-1")).toEqual({
      name: "chat-1", path: PROJECT + "/.claude/worktrees/chat-1", branch: "worktree-chat-1",
    });
    expect(worktreeOfCwd(PROJECT, PROJECT)).toBeNull();
    expect(worktreeOfCwd(PROJECT, PROJECT + "/.claude/worktrees/chat-1/src")).toBeNull();
    expect(worktreeOfCwd(PROJECT, "/workspace/project-b/.claude/worktrees/chat-1")).toBeNull();
    expect(worktreeOfCwd(PROJECT, PROJECT + "/.claude/worktrees/../../etc")).toBeNull();
    expect(worktreeOfCwd(PROJECT, undefined)).toBeNull();
  });

  it("makes names that pass its own check", () => {
    const name = newWorktreeName(new Date(2026, 10, 20, 9, 5), () => 0.5);
    expect(name).toBe("chat-261120-0905-8000");
    expect(WORKTREE_NAME_RE.test(name)).toBe(true);
    expect(WORKTREE_NAME_RE.test("../x")).toBe(false);
  });
});

describe("the record and the ownership check", () => {
  let claudeRoot: string;
  beforeEach(() => {
    setDb(openTestDb());
    claudeRoot = mkdtempSync(join(tmpdir(), "ppm-claude-root-"));
    _setClaudeProjectsRoot(claudeRoot);
  });
  afterEach(() => {
    _setClaudeProjectsRoot(null);
    rmSync(claudeRoot, { recursive: true, force: true });
  });

  const wt = { name: "chat-1", path: PROJECT + "/.claude/worktrees/chat-1", branch: "worktree-chat-1" };
  function writeTranscript(cwd: string): void {
    const dir = join(claudeRoot, slugOf(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, SID + ".jsonl"), "{}\n");
  }

  it("keeps the first worktree reported and lists it by session", () => {
    recordSessionWorktree(SID, PROJECT, wt);
    recordSessionWorktree(SID, PROJECT, { ...wt, path: PROJECT + "/.claude/worktrees/other" });
    expect(getSessionWorktree(SID)).toEqual({ ...wt, projectPath: PROJECT });
    expect(getSessionWorktrees([SID, "x"])).toEqual(new Map([[SID, wt]]));
  });

  it("finds the transcript under the worktree's slug only once PPM recorded that worktree for this project", () => {
    writeTranscript(wt.path);
    expect(assertSessionInProject({ providerId: "claude", sessionId: SID, projectPath: PROJECT }).ok).toBe(false);
    recordSessionWorktree(SID, PROJECT, wt);
    const owned = assertSessionInProject({ providerId: "claude", sessionId: SID, projectPath: PROJECT });
    expect(owned.ok).toBe(true);
    // Another project asking for the same session is still refused.
    expect(assertSessionInProject({ providerId: "claude", sessionId: SID, projectPath: "/workspace/project-b" }).ok).toBe(false);
  });
});

describe("excludeWorktreesFromGit", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "ppm-wt-repo-"));
    Bun.spawnSync(["git", "init", "-q", repo]);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("adds one local exclude line, once, and leaves a folder that is no repository alone", async () => {
    await excludeWorktreesFromGit(repo);
    await excludeWorktreesFromGit(repo);
    const lines = readFileSync(join(repo, ".git", "info", "exclude"), "utf8").split("\n");
    expect(lines.filter((l) => l === "/.claude/worktrees/")).toHaveLength(1);
    const plain = mkdtempSync(join(tmpdir(), "ppm-wt-plain-"));
    await excludeWorktreesFromGit(plain);
    rmSync(plain, { recursive: true, force: true });
  });
});
