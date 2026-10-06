import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPatch } from "diff";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { readBaseline, listBaselines } from "../../../src/services/session-file-baselines/session-file-baselines.service.ts";
import { recordFileChangeBaselines } from "../../../src/providers/codex-app-server/codex-file-baselines.ts";
import { _resetSessionFileHistory, readHistory } from "../../../src/services/session-file-baselines/session-file-history.ts";

// Restore, never delete: the bunfig preload's PPM_HOME shields later test files from ~/.ppm.
const ORIGINAL_PPM_HOME = process.env.PPM_HOME;
const SESSION = "019a0bcb-1e03-7960-9bbb-1d8d9922eeaa";
let work: string;

beforeEach(() => {
  process.env.PPM_HOME = mkdtempSync(resolve(tmpdir(), "ppm-codex-baselines-home-"));
  _resetPpmDir();
  _resetSessionFileHistory();
  work = mkdtempSync(resolve(tmpdir(), "ppm-codex-baselines-work-"));
});

afterEach(() => {
  if (ORIGINAL_PPM_HOME === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = ORIGINAL_PPM_HOME;
  _resetPpmDir();
});

const hunks = (before: string, after: string) => {
  const p = createPatch("f", before, after, "", "", { context: 1 });
  return p.slice(p.indexOf("@@"));
};

describe("recordFileChangeBaselines", () => {
  test("works out each file's before from a completed patch that is already on disk", () => {
    const updated = join(work, "plan.md");
    const before = "a\nb\nc\nd\n";
    const after = "a\nB\nc\nd\nE\n";
    writeFileSync(updated, after);
    recordFileChangeBaselines(SESSION, {
      type: "fileChange",
      status: "completed",
      changes: [
        { path: updated, kind: { type: "update", move_path: null }, diff: hunks(before, after) },
        { path: join(work, "new.srt"), kind: { type: "add" }, diff: "1\n" },
        { path: join(work, "gone.txt"), kind: { type: "delete" }, diff: "was here\n" },
      ],
    });
    expect(readBaseline(SESSION, updated)).toMatchObject({ existed: true, content: before });
    expect(readBaseline(SESSION, join(work, "new.srt"))).toMatchObject({ existed: false });
    expect(readBaseline(SESSION, join(work, "gone.txt"))).toMatchObject({ existed: true, content: "was here\n" });
  });

  test("puts each file's two states in the history under the patch's item id", async () => {
    const updated = join(work, "plan.md");
    const before = "a\nb\nc\nd\n";
    const after = "a\nB\nc\nd\n";
    writeFileSync(updated, after);
    await recordFileChangeBaselines(SESSION, {
      type: "fileChange",
      id: "item_7",
      status: "completed",
      changes: [
        { path: updated, kind: { type: "update", move_path: null }, diff: hunks(before, after) },
        { path: join(work, "gone.txt"), kind: { type: "delete" }, diff: "was here\n" },
      ],
    });
    const states = (path: string) => readHistory(SESSION, path).entries.map((e) => [e.call, e.phase, e.hash === null, e.text]);
    expect(states(updated)).toEqual([["item_7", "before", false, before], ["item_7", "after", false, after]]);
    expect(states(join(work, "gone.txt"))).toEqual([["item_7", "before", false, "was here\n"], ["item_7", "after", true, ""]]);
  });

  test("a later patch to the same file does not replace the first before", () => {
    const file = join(work, "a.ts");
    writeFileSync(file, "two\n");
    recordFileChangeBaselines(SESSION, { type: "fileChange", status: "completed", changes: [{ path: file, kind: { type: "update" }, diff: hunks("one\n", "two\n") }] });
    writeFileSync(file, "three\n");
    recordFileChangeBaselines(SESSION, { type: "fileChange", status: "completed", changes: [{ path: file, kind: { type: "update" }, diff: hunks("two\n", "three\n") }] });
    expect(readBaseline(SESSION, file)?.content).toBe("one\n");
  });

  test("keeps nothing for a patch that failed, or a file changed since by something else", () => {
    const file = join(work, "a.ts");
    writeFileSync(file, "edited by hand\n");
    recordFileChangeBaselines(SESSION, { type: "fileChange", status: "completed", changes: [{ path: file, kind: { type: "update" }, diff: hunks("one\n", "two\n") }] });
    recordFileChangeBaselines(SESSION, { type: "fileChange", status: "failed", changes: [{ path: join(work, "b.ts"), kind: { type: "add" }, diff: "x" }] });
    recordFileChangeBaselines(SESSION, { type: "commandExecution", status: "completed" });
    expect(listBaselines(SESSION)).toEqual([]);
  });

  test("resolves a relative path against the thread's directory", () => {
    recordFileChangeBaselines(SESSION, { type: "fileChange", status: { type: "completed" }, changes: [{ path: "src/new.ts", kind: { type: "add" }, diff: "x\n" }] }, work);
    expect(readBaseline(SESSION, join(work, "src/new.ts"))).toMatchObject({ existed: false });
  });
});
