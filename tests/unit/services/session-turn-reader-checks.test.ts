/**
 * A turn read checks the very bytes it parses, at both ends of each range, and the file after.
 *
 * Each case rewrites the transcript in place between the scan and the read — the window the
 * cache's own stat check cannot see — and asks the read to notice rather than return a range
 * that now holds other records.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { _setClaudeProjectsRoot } from "../../../src/services/agent-transcript/claude-projects-root.ts";
import { _setCodexSessionsDirsForTest } from "../../../src/services/agent-transcript/session-ownership.ts";
import { scanSessionTurns } from "../../../src/services/session-turns/session-turn-index.service.ts";
import { readSessionTurnMessages, readTurnsFromScan, type TurnMessages } from "../../../src/services/session-turns/session-turn-reader.ts";
import { claude, codex, lines } from "./session-turn-fixtures.ts";

const root = mkdtempSync(join(tmpdir(), "ppm-turns-reader-"));
const projectPath = join(root, "proj");
const slugDir = join(root, "projects", projectPath.replace(/[/\\:.]/g, "-"));
const sessionsDir = join(root, "sessions");

const A = "44444444-0000-4000-8000-00000000000a";
const B = "44444444-0000-4000-8000-00000000000b";
const WHEN = new Date("2026-11-03T00:00:00Z");

const savedCodexHome = process.env.CODEX_HOME;
beforeAll(() => {
  mkdirSync(slugDir, { recursive: true });
  _setClaudeProjectsRoot(join(root, "projects"));
  process.env.CODEX_HOME = root;
  _setCodexSessionsDirsForTest(() => [sessionsDir]);
});
afterAll(() => {
  _setClaudeProjectsRoot(null);
  _setCodexSessionsDirsForTest(null);
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  rmSync(root, { recursive: true, force: true });
});

/** Rewrite under the same inode, keeping the old mtime so only the bytes can tell. */
function rewriteKeepingTime(path: string, body: string): void {
  writeFileSync(path, body);
  utimesSync(path, WHEN, WHEN);
}

const contents = (read: TurnMessages[] | "stale") => (read === "stale" ? read : read.flatMap((r) => r.messages.map((m) => m.content)));

describe("Claude turn reads", () => {
  const records = () => {
    const pA = claude.prompt("ask aaaa", A);
    const a1 = claude.assistant("reply one");
    const big = claude.assistant(`tool output ${"z".repeat(4000)}`);
    const pB = claude.prompt("ask bbbb", B);
    const b1 = claude.assistant("reply bbbb");
    return { pA, a1, big, pB, b1 };
  };

  function session(body: string): { ref: { providerId: string; sessionId: string; projectPath: string }; path: string } {
    const id = randomUUID();
    const path = join(slugDir, `${id}.jsonl`);
    rewriteKeepingTime(path, body);
    return { ref: { providerId: "claude", sessionId: id, projectPath }, path };
  }

  test("a rewrite that shrinks a turn between scan and read is stale, then read again correctly", async () => {
    const r = records();
    const { ref, path } = session(lines(r.pA, r.a1, r.big, r.pB, r.b1));
    const scan = await scanSessionTurns(ref);
    // Stripping the big record moves turn B up into the range the scan gave turn A.
    writeFileSync(path, lines(r.pA, r.a1, claude.assistant("[image removed]"), r.pB, r.b1));
    expect(await readTurnsFromScan(scan, [A])).toBe("stale");
    expect(contents(await readSessionTurnMessages(ref, [A]))).toEqual(["ask aaaa", "reply one", "[image removed]"]);
  });

  test("records moved under the same size and mtime are caught at the range's end", async () => {
    const r = records();
    const { ref, path } = session(lines(r.pA, r.a1, r.big, r.pB, r.b1));
    const scan = await scanSessionTurns(ref);
    const before = statSync(path).size;
    // Same bytes, one record moved to the end: turn A's start is untouched, its old end is not.
    rewriteKeepingTime(path, lines(r.pA, r.a1, r.pB, r.b1, r.big));
    expect(statSync(path).size).toBe(before);
    expect(await readTurnsFromScan(scan, [A])).toBe("stale");
  });

  test("a transcript only appended to since the scan reads as it was scanned", async () => {
    const r = records();
    const { ref, path } = session(lines(r.pA, r.a1, r.pB, r.b1));
    const scan = await scanSessionTurns(ref);
    appendFileSync(path, lines(claude.prompt("ask cccc", randomUUID())));
    expect(contents(await readTurnsFromScan(scan, [A, B]))).toEqual(["ask aaaa", "reply one", "ask bbbb", "reply bbbb"]);
  });
});

describe("Codex turn reads", () => {
  test("an implicit turn is recognised by its prompt, not by being any user message", async () => {
    const id = randomUUID();
    const dir = join(sessionsDir, "2026", "11", "03");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `rollout-2026-11-03T00-00-00-${id}.jsonl`);
    const body = (first: string) => lines(codex.meta(id, projectPath), codex.user(first), codex.agent("a1"), codex.user("two"), codex.agent("a2"));
    rewriteKeepingTime(path, body("one"));
    const ref = { providerId: "codex", sessionId: id, projectPath };
    const scan = await scanSessionTurns(ref);
    const first = scan.view.turns[0]!.turnId;
    expect(first.startsWith("u:L")).toBe(true);
    // A same-length edit of the prompt keeps a user message at the offset, but not this one.
    rewriteKeepingTime(path, body("eno"));
    expect(await readTurnsFromScan(scan, [first])).toBe("stale");
  });
});
