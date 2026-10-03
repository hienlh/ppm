/**
 * The session's per-call file history: each state stored as a small change from the one
 * before it, read back exactly, across a server restart, and through states that are not text.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import {
  _resetSessionFileHistory,
  applyDelta,
  encodeDelta,
  historyFile,
  historyPaths,
  observeFile,
  readHistory,
} from "../../../src/services/session-file-baselines/session-file-history.ts";
import { rmRetrying } from "../../helpers/rm-retrying.ts";

// Restore, never delete: the bunfig preload's PPM_HOME shields later test files from ~/.ppm.
const ORIGINAL_PPM_HOME = process.env.PPM_HOME;
const SESSION = "5f0c9a52-3c1e-4b7d-8e2f-6a1b2c3d4e5f";

let ppmHome: string;
let work: string;

beforeEach(() => {
  ppmHome = mkdtempSync(resolve(tmpdir(), "ppm-history-home-"));
  work = mkdtempSync(resolve(tmpdir(), "ppm-history-work-"));
  process.env.PPM_HOME = ppmHome;
  _resetPpmDir();
  _resetSessionFileHistory();
});

afterEach(async () => {
  if (ORIGINAL_PPM_HOME === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = ORIGINAL_PPM_HOME;
  _resetPpmDir();
  _resetSessionFileHistory();
  await rmRetrying(ppmHome);
  await rmRetrying(work);
});

const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}\n`).join("");

/** Run one call over `file`: observed before, `write` applied, observed after. */
async function call(file: string, id: string, write: () => void): Promise<void> {
  await observeFile(SESSION, file, id, "before");
  write();
  await observeFile(SESSION, file, id, "after");
}

describe("deltas", () => {
  test("round-trip byte for byte, CRLF and a missing last newline included", () => {
    const cases: [string, string][] = [
      ["a\nb\nc\n", "a\nB\nc\n"],
      ["a\r\nb\r\n", "a\r\nb\r\nc"],
      ["", "new\n"],
      ["gone\n", ""],
      ["x", "x\n"],
      [lines(200), lines(200).replace("line 100\n", "line 100\nadded\n")],
    ];
    for (const [prev, next] of cases) {
      const delta = encodeDelta(prev, next)!;
      expect(applyDelta(prev, delta)).toBe(next);
    }
  });

  test("refuse a text they were not cut from", () => {
    const delta = encodeDelta("a\nb\n", "a\nc\n")!;
    expect(applyDelta("a\n", delta)).toBeNull();
    expect(applyDelta("a\nb\nextra\n", delta)).toBeNull();
  });
});

describe("observeFile", () => {
  test("keeps every state a call finds and leaves, each read back exactly", async () => {
    const file = join(work, "app.ts");
    writeFileSync(file, lines(50));
    await call(file, "toolu_1", () => writeFileSync(file, lines(50).replace("line 10\n", "line ten\n")));
    await call(file, "toolu_2", () => writeFileSync(file, `${readFileSync(file, "utf8")}appended\n`));

    const { entries } = readHistory(SESSION, file);
    expect(entries.map((e) => [e.call, e.phase])).toEqual([
      ["toolu_1", "before"], ["toolu_1", "after"], ["toolu_2", "before"], ["toolu_2", "after"],
    ]);
    expect(entries[0]!.text).toBe(lines(50));
    expect(entries[1]!.text).toBe(lines(50).replace("line 10\n", "line ten\n"));
    expect(entries[2]!.text).toBe(entries[1]!.text);
    expect(entries[3]!.text).toBe(`${entries[1]!.text}appended\n`);
    expect(entries.map((e) => e.hash)).toEqual([entries[0]!.hash, entries[1]!.hash, entries[1]!.hash, entries[3]!.hash]);
  });

  test("stores a change, not a copy: two hundred edits of a large file stay small", async () => {
    const file = join(work, "big.ts");
    let text = lines(2000);
    writeFileSync(file, text);
    for (let i = 0; i < 200; i++) {
      await call(file, `toolu_${i}`, () => {
        text = text.replace(`line ${i + 1}\n`, `edited ${i + 1}\n`);
        writeFileSync(file, text);
      });
    }
    const log = statSync(historyFile(SESSION, file)!).size;
    // One whole copy (~22 KB) plus 200 small deltas; 200 copies would be 4.4 MB.
    expect(log).toBeLessThan(text.length + 200 * 200);
    const { entries } = readHistory(SESSION, file);
    expect(entries.at(-1)!.text).toBe(text);
  });

  test("picks up where the log ends after a restart, without a second copy", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, lines(30));
    await call(file, "toolu_1", () => writeFileSync(file, lines(30).replace("line 3\n", "three\n")));
    const before = statSync(historyFile(SESSION, file)!).size;
    _resetSessionFileHistory();
    await call(file, "toolu_2", () => writeFileSync(file, lines(30).replace("line 3\n", "three\n").replace("line 20\n", "twenty\n")));

    const added = statSync(historyFile(SESSION, file)!).size - before;
    expect(added).toBeLessThan(lines(30).length);
    expect(readHistory(SESSION, file).entries.at(-1)!.text).toBe(readFileSync(file, "utf8"));
  });

  test("reads on from a position, so a reader only pays for what is new", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, "one\n");
    await call(file, "toolu_1", () => writeFileSync(file, "one\ntwo\n"));
    const first = readHistory(SESSION, file);
    await call(file, "toolu_2", () => writeFileSync(file, "one\ntwo\nthree\n"));
    const next = readHistory(SESSION, file, first.end);
    expect(next.entries.map((e) => [e.call, e.phase, e.text])).toEqual([
      ["toolu_2", "before", "one\ntwo\n"],
      ["toolu_2", "after", "one\ntwo\nthree\n"],
    ]);
  });

  test("records a file that did not exist, or no longer does, as empty", async () => {
    const file = join(work, "new.ts");
    await call(file, "toolu_1", () => writeFileSync(file, "created\n"));
    await call(file, "toolu_2", () => unlinkSync(file));
    const { entries } = readHistory(SESSION, file);
    expect(entries.map((e) => [e.hash === null, e.text])).toEqual([
      [true, ""], [false, "created\n"], [false, "created\n"], [true, ""],
    ]);
  });

  test("keeps no text for a binary state, and stores the next text whole", async () => {
    const file = join(work, "data.bin");
    writeFileSync(file, "text\n");
    await call(file, "toolu_1", () => writeFileSync(file, Buffer.from([0, 1, 2, 0, 3])));
    await call(file, "toolu_2", () => writeFileSync(file, "text again\n"));
    const { entries } = readHistory(SESSION, file);
    expect(entries.map((e) => e.text)).toEqual(["text\n", null, null, "text again\n"]);
  });

  test("takes a state given rather than read, as a shell command's before is", async () => {
    const file = join(work, "a.txt");
    writeFileSync(file, "after\n");
    await observeFile(SESSION, file, "toolu_sh", "before", new TextEncoder().encode("before\n"));
    await observeFile(SESSION, file, "toolu_sh", "after");
    expect(readHistory(SESSION, file).entries.map((e) => e.text)).toEqual(["before\n", "after\n"]);
  });

  test("never records a credential path, or a link to one, and lists the paths it has", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, "x\n");
    await call(file, "toolu_1", () => writeFileSync(file, "y\n"));
    writeFileSync(join(ppmHome, "ppm.db"), "secret\n");
    await observeFile(SESSION, join(ppmHome, "ppm.db"), "toolu_2", "before");
    expect(historyPaths(SESSION)).toEqual([resolve(file)]);
    try {
      symlinkSync(join(ppmHome, "ppm.db"), join(work, "innocent.db"));
    } catch {
      return; // link creation needs privileges on some hosts
    }
    await observeFile(SESSION, join(work, "innocent.db"), "toolu_3", "before");
    expect(historyPaths(SESSION)).toEqual([resolve(file)]);
  });

  test("keeps observations that arrive together in the order they were made", async () => {
    const file = join(work, "a.ts");
    const states = Array.from({ length: 12 }, (_, i) => lines(40).replace(`line ${i + 1}\n`, `changed ${i + 1}\n`));
    await Promise.all(states.map((text, i) => observeFile(SESSION, file, `toolu_${i}`, "after", text)));
    expect(readHistory(SESSION, file).entries.map((e) => [e.call, e.text])).toEqual(states.map((text, i) => [`toolu_${i}`, text]));
  });

  test("starts the log again once its session's files are gone", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, "one\n");
    await call(file, "toolu_1", () => writeFileSync(file, "one\ntwo\n"));
    rmSync(historyFile(SESSION, file)!);
    await call(file, "toolu_2", () => writeFileSync(file, "one\ntwo\nthree\n"));
    expect(historyPaths(SESSION)).toEqual([resolve(file)]);
    expect(readHistory(SESSION, file).entries.map((e) => [e.call, e.text])).toEqual([
      ["toolu_2", "one\ntwo\n"],
      ["toolu_2", "one\ntwo\nthree\n"],
    ]);
  });

  test("ignores a session id that cannot name a directory", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, "x\n");
    await observeFile("../escape", file, "toolu_1", "before");
    expect(historyFile("../escape", file)).toBeNull();
  });
});
