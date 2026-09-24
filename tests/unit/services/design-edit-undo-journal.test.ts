import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesign } from "../../../src/services/design/design-store.service.ts";
import {
  MAX_UNDO_ENTRIES, changedSpan, recordEdit, resetDesignUndoJournals, undoEdit,
} from "../../../src/services/design/design-edit-undo-journal.ts";
import { computeGen } from "../../../src/services/design/source/design-source-file.ts";
import { listSnapshots } from "../../../src/services/design/design-snapshots.service.ts";

const BEFORE = '<!doctype html><html><head></head><body>\n<header>Top</header>\n<div class="card">Card</div>\n'
  + "<p>Body text that keeps the footer well away from the card.</p>\n<footer>End</footer>\n</body></html>";
const AFTER = BEFORE.replace('<div class="card">', '<div style="translate: 12px 4px" class="card">');

describe("design edit undo journal", () => {
  let project: string;
  let dir: string;
  const read = () => readFileSync(join(dir, "index.html"), "utf8");
  const write = (text: string) => writeFileSync(join(dir, "index.html"), text);
  const record = () => {
    write(AFTER);
    return recordEdit(project, "home", [changedSpan("index.html", BEFORE, AFTER)!], { "index.html": computeGen(AFTER) })!;
  };

  beforeEach(async () => {
    resetDesignUndoJournals();
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-undo-")));
    await createDesign(project, { title: "Home", kind: "page" });
    dir = join(project, "designs", "home");
    write(BEFORE);
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  it("keeps a little unchanged context around the changed region", () => {
    const span = changedSpan("index.html", BEFORE, AFTER)!;
    expect(span.newText.length - span.oldText.length).toBe(AFTER.length - BEFORE.length);
    expect(span.oldText.length).toBeGreaterThan(30);
    expect(BEFORE.slice(0, span.start) + span.newText + BEFORE.slice(span.start + span.oldText.length)).toBe(AFTER);
    expect(changedSpan("x", "same", "same")).toBeNull();
  });

  it("restores the bytes right after the edit and answers the new gen", async () => {
    const id = record();
    const out = await undoEdit(project, "home", id);
    expect(read()).toBe(BEFORE);
    expect(out.gen).toBe(computeGen(BEFORE));
    expect((await listSnapshots(project, "home")).map((s) => s.reason)).toContain("before-edit");
    // An undone edit is gone from the journal.
    await expect(undoEdit(project, "home", id)).rejects.toMatchObject({ status: 404 });
  });

  it("still undoes after an AI turn edited elsewhere in the file, and keeps that change", async () => {
    const id = record();
    const aiTurn = AFTER.replace("<footer>End</footer>", "<footer>The AI rewrote the footer</footer>");
    write(aiTurn);
    await undoEdit(project, "home", id);
    expect(read()).toBe(BEFORE.replace("<footer>End</footer>", "<footer>The AI rewrote the footer</footer>"));
  });

  it("answers cannot-undo when a later change overlaps or shifts the span, and writes nothing", async () => {
    const id = record();
    const overlapping = AFTER.replace("translate: 12px 4px", "translate: 99px 4px");
    write(overlapping);
    await expect(undoEdit(project, "home", id)).rejects.toMatchObject({ status: 409, code: "cannot-undo" });
    expect(read()).toBe(overlapping);

    write(AFTER);
    const id2 = recordEdit(project, "home", [changedSpan("index.html", BEFORE, AFTER)!], { "index.html": computeGen(AFTER) })!;
    const shifted = AFTER.replace("<header>Top</header>", "<header>A much longer header</header>");
    write(shifted);
    await expect(undoEdit(project, "home", id2)).rejects.toMatchObject({ status: 409 });
    expect(read()).toBe(shifted);
  });

  it("answers cannot-undo for a deleted file and 404 for an unknown or malformed id", async () => {
    const id = record();
    rmSync(join(dir, "index.html"));
    await expect(undoEdit(project, "home", id)).rejects.toMatchObject({ status: 409 });
    await expect(undoEdit(project, "home", "0123456789abcdef")).rejects.toMatchObject({ status: 404 });
    await expect(undoEdit(project, "home", "../../etc")).rejects.toMatchObject({ status: 404 });
    await expect(undoEdit(project, "home", 42)).rejects.toMatchObject({ status: 404 });
  });

  it("keeps the last 50 edits per design: the 51st evicts the oldest", async () => {
    const ids: string[] = [];
    for (let i = 0; i <= MAX_UNDO_ENTRIES; i++) {
      ids.push(recordEdit(project, "home", [{ file: "index.html", start: 0, oldText: "a", newText: "b" }], {})!);
    }
    await expect(undoEdit(project, "home", ids[0])).rejects.toMatchObject({ status: 404 });
    // The newest is still known (and refused on content, not as unknown).
    await expect(undoEdit(project, "home", ids[MAX_UNDO_ENTRIES])).rejects.toMatchObject({ status: 409 });
  });

  it("does not journal an edit with no spans", () => {
    expect(recordEdit(project, "home", [], {})).toBeNull();
  });
});
