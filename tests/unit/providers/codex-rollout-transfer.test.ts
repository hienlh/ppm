import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { localizeRollout } from "../../../src/providers/codex-app-server/codex-rollout-transfer.ts";

/**
 * Codex resolves a thread only against the sessions directory of the CODEX_HOME its
 * app-server is running on. Passing `path` does not get around that — a valid path under
 * another account's home is refused with "no rollout found for thread id", the same answer
 * as passing no path at all. Copying the file in is what makes a cross-account resume work.
 */
describe("localizeRollout", () => {
  let root: string;
  let sourceSessions: string;
  let targetSessions: string;
  const REL = join("2026", "09", "15", "rollout-2026-09-15T15-18-31-abc.jsonl");

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "codex-rollout-"));
    sourceSessions = join(root, "accountA", "sessions");
    targetSessions = join(root, "accountB", "sessions");
    mkdirSync(join(sourceSessions, "2026", "09", "15"), { recursive: true });
    writeFileSync(join(sourceSessions, REL), '{"type":"session_meta"}\n');
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("copies a rollout from another account into the serving home", () => {
    const out = localizeRollout(join(sourceSessions, REL), sourceSessions, targetSessions);
    expect(out).toBe(join(targetSessions, REL));
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf-8")).toBe('{"type":"session_meta"}\n');
  });

  it("keeps the date-nested layout codex scans for", () => {
    // Flattening the file into `sessions/` would leave codex unable to find it, which looks
    // exactly like the failure the copy exists to fix.
    const out = localizeRollout(join(sourceSessions, REL), sourceSessions, targetSessions);
    expect(out.endsWith(join("2026", "09", "15", "rollout-2026-09-15T15-18-31-abc.jsonl"))).toBe(true);
  });

  it("leaves the original in place, because the old account still reads it", () => {
    localizeRollout(join(sourceSessions, REL), sourceSessions, targetSessions);
    expect(existsSync(join(sourceSessions, REL))).toBe(true);
  });

  it("returns the path untouched when the rollout is already in the serving home", () => {
    const src = join(sourceSessions, REL);
    expect(localizeRollout(src, sourceSessions, sourceSessions)).toBe(src);
  });

  it("does not re-copy over a rollout already there", () => {
    const dest = join(targetSessions, REL);
    mkdirSync(join(targetSessions, "2026", "09", "15"), { recursive: true });
    // The account now serving has continued the thread, so its copy is the newer one and
    // overwriting it with the frozen original would lose every turn since the switch.
    writeFileSync(dest, "newer content\n");
    const out = localizeRollout(join(sourceSessions, REL), sourceSessions, targetSessions);
    expect(out).toBe(dest);
    expect(readFileSync(dest, "utf-8")).toBe("newer content\n");
  });
});
