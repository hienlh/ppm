import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDb, setDb, setSessionMetadata } from "../../../src/services/db.service.ts";
import { _setClaudeProjectsRoot } from "../../../src/services/agent-transcript/claude-projects-root.ts";
import { assertSessionInProject } from "../../../src/services/agent-transcript/session-ownership.ts";

const PROJECT_A = "/workspace/project-a";
const PROJECT_B = "/workspace/project-b";
const VALID_SESSION_ID = "aaaaaaaa-1111-2222-3333-444444444444";

function slugOf(projectPath: string): string {
  return projectPath.replace(/[/\\:.]/g, "-");
}

describe("assertSessionInProject", () => {
  let claudeRoot: string;
  // `isCodexRolloutPath` (codex-history.ts) jails to `homedir()`-derived roots and cannot be
  // pointed at an arbitrary temp dir, so — same as codex-history.test.ts's
  // `getCodexPreCompactMessages` suite — HOME/USERPROFILE are patched for the duration and the
  // fixture sessions dir is created under that fake home's `.codex/sessions`.
  let fakeHome: string;
  let codexRoot: string;
  const savedEnv = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };

  beforeEach(() => {
    setDb(openTestDb());
    claudeRoot = mkdtempSync(join(tmpdir(), "ppm-claude-root-"));
    fakeHome = mkdtempSync(join(tmpdir(), "ppm-codex-home-"));
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

  function writeClaudeSession(projectPath: string, sessionId: string): void {
    const dir = join(claudeRoot, slugOf(projectPath));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.jsonl`), '{"type":"user"}\n');
  }

  // ── sessionId shape ──
  it("rejects a session id that fails the shared regex", () => {
    for (const bad of ["short", "has spaces here", "../../../etc/passwd", "a".repeat(65)]) {
      const result = assertSessionInProject({ providerId: "claude", sessionId: bad, projectPath: PROJECT_A });
      expect(result.ok).toBe(false);
      expect((result as any).code).toBe("invalid_session_id");
    }
  });

  it("rejects an empty project path", () => {
    const result = assertSessionInProject({ providerId: "claude", sessionId: VALID_SESSION_ID, projectPath: "" });
    expect(result).toEqual({ ok: false, code: "invalid_project" });
  });

  it("rejects an unknown provider id", () => {
    const result = assertSessionInProject({ providerId: "bogus", sessionId: VALID_SESSION_ID, projectPath: PROJECT_A });
    expect(result).toEqual({ ok: false, code: "invalid_provider" });
  });

  // ── Claude ──
  it("accepts a Claude session whose jsonl sits under the requested project's slug dir", () => {
    writeClaudeSession(PROJECT_A, VALID_SESSION_ID);
    const result = assertSessionInProject({ providerId: "claude", sessionId: VALID_SESSION_ID, projectPath: PROJECT_A });
    expect(result.ok).toBe(true);
    expect((result as any).claude.sessionDir.endsWith(VALID_SESSION_ID)).toBe(true);
  });

  it("rejects a session that belongs to a different project (no DB row to redeem it)", () => {
    writeClaudeSession(PROJECT_B, VALID_SESSION_ID);
    const result = assertSessionInProject({ providerId: "claude", sessionId: VALID_SESSION_ID, projectPath: PROJECT_A });
    expect(result).toEqual({ ok: false, code: "session_not_found" });
  });

  it("accepts a CLI-started session with no DB row, purely from the file on disk", () => {
    writeClaudeSession(PROJECT_A, VALID_SESSION_ID);
    // No setSessionMetadata call at all — simulates a session PPM never created.
    const result = assertSessionInProject({ providerId: "claude", sessionId: VALID_SESSION_ID, projectPath: PROJECT_A });
    expect(result.ok).toBe(true);
  });

  it("uses the cross-project fallback only when the DB names the SAME project", () => {
    // Directory encodes PROJECT_A without a trailing slash; the caller asks with one,
    // so the literal slug differs and the primary lookup misses.
    writeClaudeSession(PROJECT_A, VALID_SESSION_ID);
    setSessionMetadata(VALID_SESSION_ID, "proj", PROJECT_A);
    const result = assertSessionInProject({
      providerId: "claude", sessionId: VALID_SESSION_ID, projectPath: `${PROJECT_A}/`,
    });
    expect(result.ok).toBe(true);
  });

  it("refuses the fallback when the DB names a different project than requested", () => {
    writeClaudeSession(PROJECT_B, VALID_SESSION_ID);
    setSessionMetadata(VALID_SESSION_ID, "proj-b", PROJECT_B);
    const result = assertSessionInProject({ providerId: "claude", sessionId: VALID_SESSION_ID, projectPath: PROJECT_A });
    expect(result).toEqual({ ok: false, code: "session_not_found" });
  });

  // ── Codex ──
  function writeCodexRollout(id: string, cwd: string, extra: Record<string, unknown> = {}): void {
    const day = join(codexRoot, "2026", "10", "01");
    mkdirSync(day, { recursive: true });
    const meta = { type: "session_meta", payload: { id, cwd, timestamp: "2026-10-01T00:00:00Z", ...extra } };
    writeFileSync(join(day, `rollout-${id}.jsonl`), JSON.stringify(meta) + "\n");
  }

  it("accepts a Codex session found (fail-closed on cwd) across the injected dirs", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    writeCodexRollout(id, PROJECT_A);
    const result = assertSessionInProject({
      providerId: "codex", sessionId: id, projectPath: PROJECT_A,
      codexSessionsDirs: () => [codexRoot],
    });
    expect(result.ok).toBe(true);
    expect((result as any).codex.path).toContain(`rollout-${id}.jsonl`);
  });

  it("rejects a Codex session whose rollout cwd does not match the requested project", () => {
    const id = "22222222-2222-4333-8444-555555555555";
    writeCodexRollout(id, PROJECT_B);
    const result = assertSessionInProject({
      providerId: "codex", sessionId: id, projectPath: PROJECT_A,
      codexSessionsDirs: () => [codexRoot],
    });
    expect(result).toEqual({ ok: false, code: "session_not_found" });
  });

  it("rejects a Codex session absent from every injected dir", () => {
    const id = "33333333-2222-4333-8444-555555555555";
    const result = assertSessionInProject({
      providerId: "codex", sessionId: id, projectPath: PROJECT_A,
      codexSessionsDirs: () => [codexRoot],
    });
    expect(result).toEqual({ ok: false, code: "session_not_found" });
  });
});
