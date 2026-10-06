/**
 * Reverting a turn: the changes its calls made, put back where their lines are still as the
 * turn left them, the others named with what changed them since — previewed first, refused
 * once the disk moved on, and undone by the same journal a revert answer uses.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { _resetSessionFileHistory, observeFile } from "../../../src/services/session-file-baselines/session-file-history.ts";
import { revertTurn } from "../../../src/services/session-file-baselines/session-turn-revert.ts";
import { undoSessionAnswer } from "../../../src/services/session-file-baselines/session-review-actions.ts";
import { rmRetrying } from "../../helpers/rm-retrying.ts";

const ORIGINAL_PPM_HOME = process.env.PPM_HOME;
const SESSION = "3a9e5b17-6c2d-4f80-9b1e-2d3c4b5a6f70";

let ppmHome: string;
let work: string;

beforeEach(() => {
  ppmHome = mkdtempSync(resolve(tmpdir(), "ppm-turn-revert-home-"));
  work = mkdtempSync(resolve(tmpdir(), "ppm-turn-revert-work-"));
  process.env.PPM_HOME = ppmHome;
  _resetPpmDir();
  _resetSessionFileHistory();
  setDb(openTestDb());
});

afterEach(async () => {
  if (ORIGINAL_PPM_HOME === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = ORIGINAL_PPM_HOME;
  _resetPpmDir();
  _resetSessionFileHistory();
  await rmRetrying(ppmHome);
  await rmRetrying(work);
});

const BASE = Array.from({ length: 40 }, (_, i) => `line ${i + 1}\n`).join("");

/** `text` with its line `n` replaced by `by` ("" takes it out). */
function set(text: string, n: number, by: string): string {
  return text.replace(`line ${n}\n`, by);
}

/** One call over `file`: observed before, `next` written (null deletes it), observed after. */
async function call(file: string, id: string, next: string | null): Promise<void> {
  await observeFile(SESSION, file, id, "before");
  if (next === null) unlinkSync(file);
  else writeFileSync(file, next);
  await observeFile(SESSION, file, id, "after");
}

const read = (file: string) => readFileSync(file, "utf8");

/** Preview the turn, then apply it at the versions the preview showed. */
async function revertNow(calls: string[]) {
  const preview = await revertTurn({ sessionId: SESSION, calls });
  const applied = await revertTurn({ sessionId: SESSION, calls, apply: preview.files.map((f) => ({ path: f.path, version: f.version })) });
  return { preview, applied };
}

describe("revertTurn", () => {
  test("previews without writing, then puts the turn's change back and leaves another turn's", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, BASE);
    const one = set(BASE, 5, "five\n");
    await call(file, "toolu_1", one);
    const two = set(one, 30, "thirty\n");
    await call(file, "toolu_2", two);

    const preview = await revertTurn({ sessionId: SESSION, calls: ["toolu_1"] });
    expect(preview.files).toEqual([
      { path: resolve(file), version: expect.any(String), action: "edit", changes: 1, added: 1, removed: 1, skipped: [] },
    ]);
    expect(read(file)).toBe(two);

    const applied = await revertTurn({ sessionId: SESSION, calls: ["toolu_1"], apply: [{ path: resolve(file), version: preview.files[0]!.version }] });
    expect(applied.stale).toBeUndefined();
    expect(applied.undoId).toEqual(expect.any(String));
    expect(read(file)).toBe(set(BASE, 30, "thirty\n"));
  });

  test("takes every call of the turn off, newest first, through another turn's change between them", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, BASE);
    const one = set(BASE, 5, "five\n");
    await call(file, "toolu_1", one);
    const two = set(one, 20, "twenty\n");
    await call(file, "toolu_2", two);
    await call(file, "toolu_3", two.replace("five\n", "FIVE\n"));

    const { preview } = await revertNow(["toolu_1", "toolu_3"]);
    expect(preview.files[0]).toMatchObject({ action: "edit", changes: 2, skipped: [] });
    expect(read(file)).toBe(set(BASE, 20, "twenty\n"));
  });

  test("leaves a change a later call rewrote, names that call, and still puts back the rest", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, BASE);
    const one = set(set(BASE, 5, "five\n"), 30, "thirty\n");
    await call(file, "toolu_1", one);
    await call(file, "toolu_2", one.replace("five\n", "5ive\n"));

    const { preview } = await revertNow(["toolu_1"]);
    expect(preview.files[0]).toMatchObject({ action: "edit", changes: 1, skipped: [{ line: 5, by: ["toolu_2"] }] });
    expect(read(file)).toBe(set(BASE, 5, "5ive\n"));
  });

  test("names no call for a change made outside one, and writes nothing when nothing can go back", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, BASE);
    const one = set(BASE, 5, "five\n");
    await call(file, "toolu_1", one);
    const byHand = one.replace("five\n", "five, by hand\n");
    writeFileSync(file, byHand);

    const { preview, applied } = await revertNow(["toolu_1"]);
    expect(preview.files[0]).toMatchObject({ action: "none", changes: 0, skipped: [{ line: 5, by: [""] }] });
    expect(applied.undoId).toBeUndefined();
    expect(read(file)).toBe(byHand);
  });

  test("does not hold a change back for the turn's own later call", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, BASE);
    const one = set(BASE, 5, "five\n");
    await call(file, "toolu_1", one);
    // Another turn's call in between, then the first turn's own over the same line.
    const two = set(one, 20, "twenty\n");
    await call(file, "toolu_2", two);
    await call(file, "toolu_3", two.replace("five\n", "FIVE\n"));
    writeFileSync(file, two.replace("five\n", "FIVE, by hand\n"));

    const { preview } = await revertNow(["toolu_1", "toolu_3"]);
    expect(preview.files[0]!.skipped).toEqual([{ line: 5, by: [""] }]);
  });

  test("deletes a file the turn created, once nothing else is in it", async () => {
    const file = join(work, "new.ts");
    await call(file, "toolu_1", "created\nfile\n");

    const { preview } = await revertNow(["toolu_1"]);
    expect(preview.files[0]).toMatchObject({ action: "delete", changes: 1, added: 2, removed: 0 });
    expect(existsSync(file)).toBe(false);
  });

  test("keeps a file the turn created when a later call wrote into it, and takes out only the turn's lines", async () => {
    const file = join(work, "new.ts");
    await call(file, "toolu_1", "created\n");
    await call(file, "toolu_2", "created\nlater\n");

    const { preview } = await revertNow(["toolu_1"]);
    expect(preview.files[0]).toMatchObject({ action: "edit", changes: 1 });
    expect(read(file)).toBe("later\n");
  });

  test("brings back a file the turn deleted", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, BASE);
    await call(file, "toolu_1", null);

    const { preview } = await revertNow(["toolu_1"]);
    expect(preview.files[0]).toMatchObject({ action: "restore", changes: 1, added: 0, removed: 40 });
    expect(read(file)).toBe(BASE);
  });

  test("puts lines the turn took out back before the line after them when the line before is gone", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, BASE);
    const one = set(set(set(BASE, 10, ""), 11, ""), 12, "");
    await call(file, "toolu_1", one);
    const two = set(one, 9, "nine\n");
    await call(file, "toolu_2", two);

    const { preview } = await revertNow(["toolu_1"]);
    expect(preview.files[0]).toMatchObject({ action: "edit", changes: 1, removed: 3, skipped: [] });
    expect(read(file)).toBe(set(BASE, 9, "nine\n"));
  });

  test("leaves lines the turn took out once something was put in between the lines around them", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, BASE);
    const one = set(set(set(BASE, 10, ""), 11, ""), 12, "");
    await call(file, "toolu_1", one);
    const two = one.replace("line 13\n", "inserted\nline 13\n");
    await call(file, "toolu_2", two);

    const { preview } = await revertNow(["toolu_1"]);
    expect(preview.files[0]).toMatchObject({ action: "none", changes: 0, skipped: [{ line: 11, by: ["toolu_2"] }] });
    expect(read(file)).toBe(two);
  });

  test("leaves a file the turn deleted once another call wrote it again", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, BASE);
    await call(file, "toolu_1", null);
    await call(file, "toolu_2", "new\n");

    const { preview } = await revertNow(["toolu_1"]);
    expect(preview.files[0]).toMatchObject({ action: "none", skipped: [{ line: 1, by: ["toolu_2"] }] });
    expect(read(file)).toBe("new\n");
  });

  test("deletes an empty file the turn created", async () => {
    const file = join(work, "empty.ts");
    await call(file, "toolu_1", "");

    const { preview } = await revertNow(["toolu_1"]);
    expect(preview.files[0]).toMatchObject({ action: "delete", changes: 0 });
    expect(existsSync(file)).toBe(false);
  });

  test("leaves lines the turn put in once another call put lines between them", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, BASE);
    const one = BASE.replace("line 5\n", "line 5\nx\ny\n");
    await call(file, "toolu_1", one);
    const two = one.replace("x\ny\n", "x\nz\ny\n");
    await call(file, "toolu_2", two);

    const { preview } = await revertNow(["toolu_1"]);
    expect(preview.files[0]).toMatchObject({ action: "none", skipped: [{ line: 6, by: ["toolu_2"] }] });
    expect(read(file)).toBe(two);
  });

  test("says why a turn that left the file binary cannot be reverted by lines", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, BASE);
    await call(file, "toolu_1", "\0binary\0");
    await call(file, "toolu_2", BASE);
    const { files } = await revertTurn({ sessionId: SESSION, calls: ["toolu_1"] });
    expect(files[0]).toMatchObject({ action: "none", error: expect.stringContaining("binary") });
  });

  test("has nothing left to do for a turn already reverted", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, BASE);
    await call(file, "toolu_1", set(set(BASE, 5, "five\n"), 30, ""));
    await revertNow(["toolu_1"]);
    expect(read(file)).toBe(BASE);

    const again = await revertTurn({ sessionId: SESSION, calls: ["toolu_1"] });
    expect(again.files[0]).toMatchObject({ action: "none", changes: 0, skipped: [] });
  });

  test("refuses to write once a file moved on since the preview, or the preview left one out", async () => {
    const a = join(work, "a.ts");
    const b = join(work, "b.ts");
    writeFileSync(a, BASE);
    writeFileSync(b, BASE);
    await call(a, "toolu_1", set(BASE, 5, "five\n"));
    await call(b, "toolu_1", set(BASE, 5, "five\n"));
    const preview = await revertTurn({ sessionId: SESSION, calls: ["toolu_1"] });
    const shown = preview.files.map((f) => ({ path: f.path, version: f.version }));

    const moved = set(BASE, 5, "five\n").replace("line 30\n", "thirty\n");
    writeFileSync(a, moved);
    const late = await revertTurn({ sessionId: SESSION, calls: ["toolu_1"], apply: shown });
    expect(late.stale).toBe(true);
    expect(late.undoId).toBeUndefined();
    expect([read(a), read(b)]).toEqual([moved, set(BASE, 5, "five\n")]);

    const partial = await revertTurn({ sessionId: SESSION, calls: ["toolu_1"], apply: late.files.slice(0, 1).map((f) => ({ path: f.path, version: f.version })) });
    expect(partial.stale).toBe(true);
    expect(read(b)).toBe(set(BASE, 5, "five\n"));
  });

  test("leaves a file written while the turn is being reverted, and still writes and undoes the others", async () => {
    // Two names for one file: putting a.ts back writes b.ts after b.ts was worked out, as a
    // later turn still running would.
    const a = join(work, "a.ts");
    const b = join(work, "b.ts");
    writeFileSync(a, BASE);
    linkSync(a, b);
    const one = set(BASE, 5, "five\n");
    await call(a, "toolu_1", one);
    const two = set(one, 30, "thirty\n");
    await call(b, "toolu_1", two);

    const { applied } = await revertNow(["toolu_1"]);
    expect(applied.stale).toBeUndefined();
    expect(applied.files).toEqual([
      expect.objectContaining({ path: resolve(a), action: "edit" }),
      expect.objectContaining({ path: resolve(b), action: "none", error: expect.stringContaining("changed while") }),
    ]);
    expect(applied.files[0]!.error).toBeUndefined();
    // Line 5 went back with a.ts, and b.ts's revert, worked out before that, did not write over it.
    expect(read(a)).toBe(set(BASE, 30, "thirty\n"));

    const back = await undoSessionAnswer({ sessionId: SESSION, projectPath: work, undoId: applied.undoId! });
    expect(back.stale).toBeUndefined();
    expect(read(b)).toBe(two);
  });

  test("writes nothing when what Undo needs cannot be saved first", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, BASE);
    await call(file, "toolu_1", set(BASE, 5, "five\n"));
    // A file where the undo folder goes: no journal can be written there.
    writeFileSync(join(ppmHome, "session-baselines", SESSION, "undo"), "");
    const { applied } = await revertNow(["toolu_1"]);
    expect(applied.undoId).toBeUndefined();
    expect(applied.files).toEqual([expect.objectContaining({ path: resolve(file), action: "none", error: expect.stringContaining("Undo") })]);
    expect(read(file)).toBe(set(BASE, 5, "five\n"));
  });

  test("is undone like a revert answer, every file of it", async () => {
    const a = join(work, "a.ts");
    const created = join(work, "new.ts");
    writeFileSync(a, BASE);
    const one = set(BASE, 5, "five\n");
    await call(a, "toolu_1", one);
    await call(created, "toolu_1", "new\n");

    const { applied } = await revertNow(["toolu_1"]);
    expect([read(a), existsSync(created)]).toEqual([BASE, false]);

    const back = await undoSessionAnswer({ sessionId: SESSION, projectPath: work, undoId: applied.undoId! });
    expect(back.stale).toBeUndefined();
    expect([read(a), read(created)]).toEqual([one, "new\n"]);
  });

  // A file symlink needs Developer Mode on Windows.
  test.skipIf(process.platform === "win32")("never takes away the file a symbolic link the turn made names, nor writes through one", async () => {
    const data = join(work, "elsewhere", "data.csv");
    mkdirSync(join(work, "elsewhere"));
    writeFileSync(data, "a,b\n");
    const link = join(work, "data.csv");
    await observeFile(SESSION, link, "toolu_1", "before");
    symlinkSync(data, link);
    await observeFile(SESSION, link, "toolu_1", "after");
    const agents = join(work, "AGENTS.md");
    const claude = join(work, "CLAUDE.md");
    writeFileSync(agents, BASE);
    symlinkSync("AGENTS.md", claude);
    await call(claude, "toolu_1", set(BASE, 5, "five\n"));

    const { preview, applied } = await revertNow(["toolu_1"]);
    expect(preview.files.map((f) => f.action)).toEqual(["edit", "delete"]);
    expect(applied.files).toEqual([
      expect.objectContaining({ path: resolve(claude), action: "none", error: expect.stringContaining("symbolic link") }),
      expect.objectContaining({ path: resolve(link), action: "none", error: expect.stringContaining("symbolic link") }),
    ]);
    expect(applied.undoId).toBeUndefined();
    expect([read(data), read(agents)]).toEqual(["a,b\n", set(BASE, 5, "five\n")]);
    expect([lstatSync(link).isSymbolicLink(), lstatSync(claude).isSymbolicLink()]).toEqual([true, true]);
  });

  test("says why a file cannot be reverted by lines", async () => {
    const file = join(work, "data.bin");
    writeFileSync(file, "text\n");
    await call(file, "toolu_1", "\0binary\0");
    const { files } = await revertTurn({ sessionId: SESSION, calls: ["toolu_1"] });
    expect(files[0]).toMatchObject({ action: "none", error: expect.any(String) });
  });

  test("has nothing for calls the session never saw", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, BASE);
    await call(file, "toolu_1", set(BASE, 5, "five\n"));
    expect(await revertTurn({ sessionId: SESSION, calls: ["toolu_other"] })).toEqual({ files: [] });
  });
});
