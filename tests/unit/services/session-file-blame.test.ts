/**
 * Which calls wrote each block of a file's review, read off the session's per-call history:
 * the call that put a line in or took it out, nobody for a change between calls, and only the
 * calls after a review mark when the blocks are cut against the mark.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { _resetSessionFileHistory, observeFile } from "../../../src/services/session-file-baselines/session-file-history.ts";
import { _resetSessionFileBlame, blockCalls } from "../../../src/services/session-file-baselines/session-file-blame.ts";
import { computeBlocks } from "../../../src/shared/review-blocks.ts";
import { rmRetrying } from "../../helpers/rm-retrying.ts";

const ORIGINAL_PPM_HOME = process.env.PPM_HOME;
const SESSION = "7c2d9e41-0b3a-4f6c-9d8e-1a2b3c4d5e6f";

let ppmHome: string;
let work: string;

beforeEach(() => {
  ppmHome = mkdtempSync(resolve(tmpdir(), "ppm-blame-home-"));
  work = mkdtempSync(resolve(tmpdir(), "ppm-blame-work-"));
  process.env.PPM_HOME = ppmHome;
  _resetPpmDir();
  _resetSessionFileHistory();
  _resetSessionFileBlame();
});

afterEach(async () => {
  if (ORIGINAL_PPM_HOME === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = ORIGINAL_PPM_HOME;
  _resetPpmDir();
  await rmRetrying(ppmHome);
  await rmRetrying(work);
});

const BASE = Array.from({ length: 40 }, (_, i) => `line ${i + 1}\n`).join("");

function replaceLine(text: string, n: number, by: string): string {
  return text.replace(`line ${n}\n`, by);
}

async function call(file: string, id: string, next: string): Promise<void> {
  await observeFile(SESSION, file, id, "before");
  writeFileSync(file, next);
  await observeFile(SESSION, file, id, "after");
}

function blame(file: string, base: string, current: string, markedAt?: number): string[][] | null {
  const diff = computeBlocks(base, current)!;
  return blockCalls({ sessionId: SESSION, path: file, baseText: base, currentText: current, blocks: diff.blocks, markedAt });
}

describe("blockCalls", () => {
  test("names the call that wrote each block, added and removed lines alike", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, BASE);
    const one = replaceLine(BASE, 5, "five\n");
    await call(file, "toolu_1", one);
    const two = replaceLine(one, 30, "");
    await call(file, "toolu_2", two);
    expect(blame(file, BASE, two)).toEqual([["toolu_1"], ["toolu_2"]]);
  });

  test("names every call that touched a block, in the order they ran", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, BASE);
    const one = replaceLine(BASE, 10, "ten\n");
    await call(file, "toolu_1", one);
    const two = replaceLine(one, 11, "eleven\n");
    await call(file, "toolu_2", two);
    expect(blame(file, BASE, two)).toEqual([["toolu_1", "toolu_2"]]);
  });

  test("names nobody for a change made between two calls", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, BASE);
    const one = replaceLine(BASE, 5, "five\n");
    await call(file, "toolu_1", one);
    // The user's own edit, then another call elsewhere.
    const byHand = replaceLine(one, 20, "twenty by hand\n");
    writeFileSync(file, byHand);
    const two = replaceLine(byHand, 35, "thirty-five\n");
    await call(file, "toolu_2", two);
    expect(blame(file, BASE, two)).toEqual([["toolu_1"], [], ["toolu_2"]]);
  });

  test("names nobody for what changed after the last call", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, BASE);
    const one = replaceLine(BASE, 5, "five\n");
    await call(file, "toolu_1", one);
    const now = replaceLine(one, 30, "thirty, later\n");
    expect(blame(file, BASE, now)).toEqual([["toolu_1"], []]);
  });

  test("names nobody for a change whose call was never seen starting", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, BASE);
    const one = replaceLine(BASE, 5, "five\n");
    await call(file, "toolu_1", one);
    // A change by hand, then a call whose "before" never arrived: the two cannot be told apart.
    const two = replaceLine(replaceLine(one, 20, "twenty by hand\n"), 35, "thirty-five\n");
    writeFileSync(file, two);
    await observeFile(SESSION, file, "toolu_2", "after");
    expect(blame(file, BASE, two)).toEqual([["toolu_1"], [], []]);
  });

  test("names nobody for a change across a state that was not text", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, BASE);
    await call(file, "toolu_1", "\0binary\0");
    const back = replaceLine(BASE, 5, "five\n");
    await call(file, "toolu_2", back);
    expect(blame(file, BASE, back)).toEqual([[]]);
  });

  test("finds a call's lines where they moved to after the last call", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, BASE);
    const one = BASE.replace("line 20\n", "line 20\ninserted\n");
    await call(file, "toolu_1", one);
    // A line put on top by hand moves the call's own line one down.
    const now = `added on top\n${one}`;
    expect(blame(file, BASE, now)).toEqual([[], ["toolu_1"]]);
  });

  test("follows a log as it grows", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, BASE);
    const one = replaceLine(BASE, 5, "five\n");
    await call(file, "toolu_1", one);
    expect(blame(file, BASE, one)).toEqual([["toolu_1"]]);
    const two = replaceLine(one, 30, "thirty\n");
    await call(file, "toolu_2", two);
    expect(blame(file, BASE, two)).toEqual([["toolu_1"], ["toolu_2"]]);
  });

  test("against a review mark, names only the calls after it", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, BASE);
    const one = replaceLine(BASE, 5, "five\n");
    await call(file, "toolu_1", one);
    await Bun.sleep(5);
    const markedAt = Date.now();
    await Bun.sleep(5);
    const two = replaceLine(one, 6, "six\n");
    await call(file, "toolu_2", two);
    // Cut against the marked state, only line 6 is a change, and only toolu_2 made it.
    expect(blame(file, one, two, markedAt)).toEqual([["toolu_2"]]);
  });

  test("against a review mark, names the call that took out a line written before the mark", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, BASE);
    const one = BASE.replace("line 5\n", "line 5\nadded\n");
    await call(file, "toolu_1", one);
    await Bun.sleep(5);
    const markedAt = Date.now();
    await Bun.sleep(5);
    await call(file, "toolu_2", BASE);
    // Cut against the marked state, the only change is the line toolu_2 took out.
    expect(blame(file, one, BASE, markedAt)).toEqual([["toolu_2"]]);
  });

  test("has nothing to say for a file with no history", () => {
    const file = join(work, "none.ts");
    expect(blame(file, BASE, replaceLine(BASE, 1, "one\n"))).toBeNull();
  });
});
