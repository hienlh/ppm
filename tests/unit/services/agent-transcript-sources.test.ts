import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setClaudeProjectsRoot } from "../../../src/services/agent-transcript/claude-projects-root.ts";
import { assertSessionInProject, type OwnedSession } from "../../../src/services/agent-transcript/session-ownership.ts";
import { resolveSources, _resetSourcesCache } from "../../../src/services/agent-transcript/agent-transcript-sources.ts";

const PROJECT_A = "/workspace/project-a";
const PROJECT_B = "/workspace/project-b";
const SESSION_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const TEAM_ID = "bbbbbbbb-1111-2222-3333-444444444444";

function slugOf(projectPath: string): string {
  return projectPath.replace(/[/\\:.]/g, "-");
}

describe("resolveSources", () => {
  let claudeRoot: string;
  // `isCodexRolloutPath` jails to `homedir()`-derived roots, so — same pattern as
  // codex-history.test.ts's `getCodexPreCompactMessages` suite — HOME/USERPROFILE are
  // patched for the duration and fixtures live under that fake home's `.codex/sessions`.
  let fakeHome: string;
  let codexRoot: string;
  const savedEnv = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };

  beforeEach(() => {
    _resetSourcesCache();
    claudeRoot = mkdtempSync(join(tmpdir(), "ppm-sources-claude-"));
    fakeHome = mkdtempSync(join(tmpdir(), "ppm-sources-codex-home-"));
    codexRoot = join(fakeHome, ".codex", "sessions");
    mkdirSync(codexRoot, { recursive: true });
    process.env.USERPROFILE = fakeHome;
    process.env.HOME = fakeHome;
    _setClaudeProjectsRoot(claudeRoot);
  });

  afterEach(() => {
    _setClaudeProjectsRoot(null);
    if (savedEnv.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedEnv.USERPROFILE;
    if (savedEnv.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = savedEnv.HOME;
    rmSync(claudeRoot, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  function writeClaudeSessionFile(projectPath: string, sessionId: string): string {
    const dir = join(claudeRoot, slugOf(projectPath));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.jsonl`), '{"type":"user"}\n');
    return dir;
  }

  function ownClaudeSession(sessionId = SESSION_ID, projectPath = PROJECT_A): OwnedSession {
    writeClaudeSessionFile(projectPath, sessionId);
    const owned = assertSessionInProject({ providerId: "claude", sessionId, projectPath });
    if (!owned.ok) throw new Error("test setup: session should own");
    return owned;
  }

  function writeAgentTranscript(subagentsDir: string, agentId: string, meta: Record<string, unknown>, lines: unknown[]): void {
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
    writeFileSync(join(subagentsDir, `agent-${agentId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }

  const assistantLine = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });

  // ── Claude card ──
  it("resolves a Claude card's root + nested agents, depth-ordered", () => {
    const owned = ownClaudeSession();
    const subagentsDir = join(owned.claude!.sessionDir, "subagents");
    writeAgentTranscript(subagentsDir, "root1", { toolUseId: "toolu_card1" }, [assistantLine("root step")]);
    writeAgentTranscript(subagentsDir, "nested1", { parentAgentId: "root1" }, [assistantLine("nested step")]);

    const result = resolveSources(owned, { kind: "card", cardId: "toolu_card1" });
    expect(Array.isArray(result)).toBe(true);
    const files = result as { key: string; path: string; provider: string }[];
    expect(files.map((f) => f.key)).toEqual(["root1", "nested1"]);
    expect(files.every((f) => f.provider === "claude")).toBe(true);
  });

  it("rejects a card id not present in the session's transcript index", () => {
    const owned = ownClaudeSession();
    writeAgentTranscript(join(owned.claude!.sessionDir, "subagents"), "root1", { toolUseId: "toolu_other" }, [assistantLine("x")]);
    const result = resolveSources(owned, { kind: "card", cardId: "toolu_card1" });
    expect(result).toEqual({ ok: false, code: "card_not_found" });
  });

  it("rejects a malformed Claude card id before touching disk", () => {
    const owned = ownClaudeSession();
    const result = resolveSources(owned, { kind: "card", cardId: "../etc/passwd" });
    expect(result).toEqual({ ok: false, code: "invalid_card_id" });
  });

  // ── Codex card ──
  function writeCodexRollout(id: string, cwd: string, extra: Record<string, unknown> = {}): void {
    const day = join(codexRoot, "2026", "10", "01");
    mkdirSync(day, { recursive: true });
    const meta = { type: "session_meta", payload: { id, cwd, timestamp: "2026-10-01T00:00:00Z", ...extra } };
    writeFileSync(join(day, `rollout-${id}.jsonl`), JSON.stringify(meta) + "\n");
  }

  function ownCodexSession(sessionId: string, projectPath = PROJECT_A): OwnedSession {
    writeCodexRollout(sessionId, projectPath);
    const owned = assertSessionInProject({
      providerId: "codex", sessionId, projectPath, codexSessionsDirs: () => [codexRoot],
    });
    if (!owned.ok) throw new Error("test setup: codex session should own");
    return owned;
  }

  it("accepts a direct child thread's card (parent_thread_id = the session)", () => {
    const owned = ownCodexSession(SESSION_ID);
    const childId = "11111111-2222-4333-8444-555555555555";
    writeCodexRollout(childId, PROJECT_A, { parent_thread_id: SESSION_ID });

    const result = resolveSources(owned, { kind: "card", cardId: `subagent-${childId}` });
    expect(Array.isArray(result)).toBe(true);
    const files = result as { key: string; path: string; provider: string }[];
    expect(files).toHaveLength(1);
    expect(files[0]!.key).toBe(childId);
    expect(files[0]!.provider).toBe("codex");
    expect(files[0]!.path).toContain(childId);
  });

  it("accepts a grandchild thread's card (two parent_thread_id hops to the session)", () => {
    const owned = ownCodexSession(SESSION_ID);
    const childId = "22222222-2222-4333-8444-555555555555";
    const grandchildId = "33333333-2222-4333-8444-555555555555";
    writeCodexRollout(childId, PROJECT_A, { parent_thread_id: SESSION_ID });
    writeCodexRollout(grandchildId, PROJECT_A, { parent_thread_id: childId });

    const result = resolveSources(owned, { kind: "card", cardId: `subagent-${grandchildId}` });
    expect(Array.isArray(result)).toBe(true);
    expect((result as any[])[0].key).toBe(grandchildId);
  });

  it("rejects a real rollout from another project even with a valid-looking card id", () => {
    const owned = ownCodexSession(SESSION_ID);
    const otherId = "44444444-2222-4333-8444-555555555555";
    writeCodexRollout(otherId, PROJECT_B); // real rollout, wrong project, no relation to the session
    const result = resolveSources(owned, { kind: "card", cardId: `subagent-${otherId}` });
    expect(result).toEqual({ ok: false, code: "card_not_found" });
  });

  it("rejects a thread that exists but never chains back to the owning session", () => {
    const owned = ownCodexSession(SESSION_ID);
    const unrelatedId = "55555555-2222-4333-8444-555555555555";
    writeCodexRollout(unrelatedId, PROJECT_A); // same project, no parent_thread_id at all
    const result = resolveSources(owned, { kind: "card", cardId: `subagent-${unrelatedId}` });
    expect(result).toEqual({ ok: false, code: "not_descendant" });
  });

  // ── Member (teammate) ──
  it("resolves a teammate's newest transcript once the team session is pinned to the project", () => {
    const teamDir = writeClaudeSessionFile(PROJECT_A, TEAM_ID);
    const owned = ownClaudeSession(SESSION_ID, PROJECT_A);
    writeAgentTranscript(join(teamDir, TEAM_ID, "subagents"), "m1", { name: "dev-p1" }, [assistantLine("teammate step")]);

    const result = resolveSources(owned, { kind: "member", teamName: TEAM_ID, memberName: "dev-p1" });
    expect(Array.isArray(result)).toBe(true);
    expect((result as any[])[0]).toMatchObject({ key: "dev-p1", provider: "claude" });
  });

  it("rejects a team session that is not pinned to the requesting project", () => {
    writeClaudeSessionFile(PROJECT_B, TEAM_ID);
    const owned = ownClaudeSession(SESSION_ID, PROJECT_A);
    const result = resolveSources(owned, { kind: "member", teamName: TEAM_ID, memberName: "dev-p1" });
    expect(result).toEqual({ ok: false, code: "member_not_found" });
  });

  // ── Caching ──
  it("caches a miss for 2s so a later file write is not immediately visible", () => {
    const owned = ownClaudeSession();
    const first = resolveSources(owned, { kind: "card", cardId: "toolu_late" });
    expect(first).toEqual({ ok: false, code: "card_not_found" });

    writeAgentTranscript(join(owned.claude!.sessionDir, "subagents"), "late1", { toolUseId: "toolu_late" }, [assistantLine("x")]);
    const stillCached = resolveSources(owned, { kind: "card", cardId: "toolu_late" });
    expect(stillCached).toEqual({ ok: false, code: "card_not_found" });

    _resetSourcesCache();
    const afterReset = resolveSources(owned, { kind: "card", cardId: "toolu_late" });
    expect(Array.isArray(afterReset)).toBe(true);
  });
});
