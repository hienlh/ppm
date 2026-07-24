import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetPpmDir, getPpmDir } from "../../src/services/ppm-dir.ts";
import {
  archiveAndDelete,
  readArchivedTranscript,
} from "../../src/services/group-chat/transcript-archive.ts";

let ppmHome: string;
let claudeProjects: string;
const prevPpmHome = process.env.PPM_HOME;
const prevClaudeProjects = process.env.CLAUDE_PROJECTS_DIR;

beforeEach(() => {
  ppmHome = mkdtempSync(join(tmpdir(), "ppm-home-"));
  claudeProjects = mkdtempSync(join(tmpdir(), "claude-projects-"));
  process.env.PPM_HOME = ppmHome;
  process.env.CLAUDE_PROJECTS_DIR = claudeProjects;
  _resetPpmDir();
});

afterEach(() => {
  if (prevPpmHome === undefined) delete process.env.PPM_HOME; else process.env.PPM_HOME = prevPpmHome;
  if (prevClaudeProjects === undefined) delete process.env.CLAUDE_PROJECTS_DIR; else process.env.CLAUDE_PROJECTS_DIR = prevClaudeProjects;
  _resetPpmDir();
  rmSync(ppmHome, { recursive: true, force: true });
  rmSync(claudeProjects, { recursive: true, force: true });
});

function seedJsonl(sessionId: string, content: string): string {
  const slugDir = join(claudeProjects, "-tmp-demo-project");
  mkdirSync(slugDir, { recursive: true });
  const p = join(slugDir, `${sessionId}.jsonl`);
  writeFileSync(p, content);
  return p;
}

describe("transcript-archive (Option A+)", () => {
  it("archives the JSONL then deletes the raw file", async () => {
    const raw = seedJsonl("sess-123", '{"type":"message"}\n');
    const res = await archiveAndDelete("sess-123", "team-a");
    expect(res.archived).toBe(true);
    expect(res.deleted).toBe(true);
    expect(existsSync(raw)).toBe(false);
    const dest = join(getPpmDir(), "teams", "team-a", "transcripts", "sess-123.jsonl");
    expect(existsSync(dest)).toBe(true);
  });

  it("readArchivedTranscript returns the archived content", async () => {
    seedJsonl("sess-abc", '{"role":"assistant","text":"hi"}\n');
    await archiveAndDelete("sess-abc", "team-b");
    const content = readArchivedTranscript("sess-abc", "team-b");
    expect(content).toContain("assistant");
  });

  it("is best-effort when raw JSONL is missing (no throw)", async () => {
    const res = await archiveAndDelete("does-not-exist", "team-c");
    expect(res.archived).toBe(false);
    expect(res.deleted).toBe(false);
  });

  it("is idempotent — second call does not throw and archive persists", async () => {
    seedJsonl("sess-dup", "line\n");
    await archiveAndDelete("sess-dup", "team-d");
    const res2 = await archiveAndDelete("sess-dup", "team-d");
    // Raw already gone: nothing to archive again, but must not throw.
    expect(res2.deleted).toBe(false);
    const dest = join(getPpmDir(), "teams", "team-d", "transcripts", "sess-dup.jsonl");
    expect(existsSync(dest)).toBe(true);
  });
});
