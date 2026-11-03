/**
 * What a cached scan really keeps alive, against what the cache's byte budget thinks it keeps.
 *
 * In Bun (JSC) a string cut from a longer one shares its storage, so a 36-character uuid read off
 * a 64 KB assistant line, or a prompt's first line cut from a pasted wall of text, holds the whole
 * line for as long as the cache holds the scan. The budget then compares a few kilobytes against
 * a limit while tens of megabytes stay resident. These scans use lines big enough that any such
 * reference dwarfs the estimate, and measure the heap after a full collection.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { heapStats } from "bun:jsc";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { claudeStateBytes, newClaudeScanState, scanClaudeTranscript } from "../../../src/services/session-turns/turn-index-claude.ts";
import { codexStateBytes, newCodexScanState, scanCodexRollout } from "../../../src/services/session-turns/turn-index-codex.ts";
import { claude, codex, lines } from "./session-turn-fixtures.ts";

const root = mkdtempSync(join(tmpdir(), "ppm-turns-memory-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * Live heap after a full collection, read from a fresh stack: JSC scans the stack
 * conservatively, so a value a frame just let go of can otherwise still count as alive.
 */
async function residentBytes(): Promise<number> {
  await new Promise((r) => setTimeout(r, 0));
  Bun.gc(true);
  Bun.gc(true);
  return heapStats().heapSize;
}

/**
 * What `scan` leaves alive, read two ways and the larger taken: the growth over a reading taken
 * before it, and what is freed once its result is dropped. A temporary the stack scan still sees
 * shrinks the first; an object the collector keeps for a cycle longer shrinks the second.
 * Neither can make a retained transcript line look smaller in both.
 */
async function retainedBy<S>(scan: () => Promise<S>, check: (state: S) => number): Promise<{ retained: number; estimate: number }> {
  const before = await residentBytes();
  const holder: { state?: S } = { state: await scan() };
  const estimate = check(holder.state!);
  const held = await residentBytes();
  holder.state = undefined;
  const after = await residentBytes();
  return { retained: Math.max(held - before, held - after), estimate };
}

const BIG = 64 * 1024;
const big = (seed: string) => `${seed} `.repeat(Math.ceil(BIG / (seed.length + 1))).slice(0, BIG);
/** Allowance for allocator and collector noise; the leak being tested is ~20 MB. */
const SLACK = 4 * 1024 * 1024;

describe("cached scan memory", () => {
  test("a Claude scan keeps no transcript line alive", async () => {
    const records: string[] = [];
    for (let t = 0; t < 20; t++) {
      // A one-line prompt far past the 200-character label: the label must not hold it.
      records.push(claude.prompt(`${big(`ask ${t}`)}`, randomUUID()));
      for (let a = 0; a < 15; a++) records.push(claude.assistant(big(`answer ${t}.${a}`)));
    }
    const file = join(root, "claude.jsonl");
    writeFileSync(file, lines(...records));
    records.length = 0;

    const { retained, estimate } = await retainedBy(async () => {
      const state = newClaudeScanState();
      await scanClaudeTranscript(file, state);
      return state;
    }, (state) => {
      expect(state.turns.length).toBe(20);
      expect(state.turnOfUuid.size).toBe(320);
      return claudeStateBytes(state);
    });
    // ~20 MB of lines went through the scan; what stays must be about what the budget counts.
    expect(retained).toBeLessThan(estimate * 3 + SLACK);
  });

  test("a Codex scan keeps no prompt's text alive", async () => {
    const records: string[] = [codex.meta(randomUUID(), "/tmp/proj")];
    for (let t = 0; t < 300; t++) {
      const id = randomUUID();
      records.push(codex.taskStarted(id), codex.user(big(`ask ${t}`)), codex.agent("ok"), codex.taskComplete(id));
    }
    const file = join(root, "codex.jsonl");
    writeFileSync(file, lines(...records));
    records.length = 0;

    const { retained, estimate } = await retainedBy(async () => {
      const state = newCodexScanState();
      await scanCodexRollout(file, state);
      return state;
    }, (state) => {
      expect(state.info.size).toBe(300);
      return codexStateBytes(state);
    });
    expect(retained).toBeLessThan(estimate * 3 + SLACK);
  });
});
