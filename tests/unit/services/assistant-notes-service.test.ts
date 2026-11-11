/**
 * The notebook's rules: the cap counts every line together (4,000 fits, 4,001 does not), an edit
 * is measured without its own old text, one line is at most 300 characters, the Assistant can
 * neither edit nor delete a line the user wrote, a line written or edited in a turn nobody started
 * is unverified and stays so until the user edits or verifies it, and only a change is announced.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { getDb } from "../../../src/services/db.service.ts";
import { createAssistantNotes, NOTE_LOCKED, normalizeNoteText } from "../../../src/services/assistant-notes/assistant-notes.service.ts";
import { NOTEBOOK_CAP_CHARS, NOTE_MAX_CHARS } from "../../../src/shared/assistant-limits.ts";

let now = 1_762_700_000_000;
let announced = 0;
const notes = createAssistantNotes({ now: () => now, announce: () => { announced++; } });
const USER = { by: "user" } as const;
const ATTENDED = { by: "assistant", unattended: false } as const;
const UNATTENDED = { by: "assistant", unattended: true } as const;

const fill = (count: number, length: number) => {
  for (let i = 0; i < count; i++) expect(notes.add("x".repeat(length), USER).ok).toBe(true);
};
const added = (text: string, writer: Parameters<typeof notes.add>[1]) => {
  const r = notes.add(text, writer);
  if (!r.ok) throw new Error(r.error);
  return r.note;
};

beforeEach(() => { getDb().run("DELETE FROM assistant_notes"); announced = 0; now += 1000; });
// Later files' Assistant turns must not find these lines in their context.
afterAll(() => { getDb().run("DELETE FROM assistant_notes"); });

describe("the cap", () => {
  it("allows exactly 4,000 characters in all and refuses the 4,001st", () => {
    fill(13, NOTE_MAX_CHARS);
    expect(notes.list().used).toBe(3900);
    const last = notes.add("y".repeat(NOTEBOOK_CAP_CHARS - 3900), USER);
    expect(last.ok).toBe(true);
    expect(notes.list().used).toBe(NOTEBOOK_CAP_CHARS);
    const over = notes.add("z", USER);
    expect(over).toMatchObject({ ok: false, code: "full" });
    expect(notes.list().notes).toHaveLength(14);
  });

  it("refuses an edit that grows past the cap, and measures it without the line's old text", () => {
    fill(13, NOTE_MAX_CHARS);
    const own = added("a".repeat(100), USER);
    expect(notes.edit(own.id, "b".repeat(101), USER)).toMatchObject({ ok: false, code: "full" });
    expect(notes.edit(own.id, "b".repeat(100), USER).ok).toBe(true);
    expect(notes.list().used).toBe(NOTEBOOK_CAP_CHARS);
  });

  it("keeps the last 1,000 characters for the user: the Assistant cannot fill them", () => {
    fill(10, NOTE_MAX_CHARS);
    expect(notes.add("one more fact", ATTENDED)).toMatchObject({ ok: false, code: "full" });
    expect(notes.add("x".repeat(NOTE_MAX_CHARS), USER).ok).toBe(true);
  });

  it("holds one line to 300 characters, refuses empty text, and keeps a line on one line", () => {
    expect(notes.add("x".repeat(NOTE_MAX_CHARS + 1), USER)).toMatchObject({ ok: false, code: "too_long" });
    expect(notes.add("x".repeat(NOTE_MAX_CHARS), USER).ok).toBe(true);
    expect(notes.add("  \n\t ", ATTENDED)).toMatchObject({ ok: false, code: "empty" });
    expect(normalizeNoteText(" a\r\nb \n\n c ")).toBe("a b c");
    expect(normalizeNoteText(42)).toBe("");
  });
});

describe("who may change a line", () => {
  it("refuses the Assistant editing or deleting a line the user wrote, in any turn", () => {
    const mine = added("never contact clients without my OK", USER);
    for (const writer of [ATTENDED, UNATTENDED]) {
      expect(notes.edit(mine.id, "contact clients freely", writer)).toEqual({ ok: false, code: "locked", error: NOTE_LOCKED });
      expect(notes.remove(mine.id, writer)).toEqual({ ok: false, code: "locked", error: NOTE_LOCKED });
    }
    expect(notes.list().notes).toEqual([expect.objectContaining({ id: mine.id, text: "never contact clients without my OK", source: "user" })]);
  });

  it("lets the Assistant edit and delete its own lines; an unknown id says so", () => {
    const own = added("deadline friday", ATTENDED);
    expect(notes.edit(own.id, "deadline monday", ATTENDED)).toMatchObject({ ok: true, note: { text: "deadline monday", source: "assistant", unverified: false } });
    expect(notes.remove(own.id, ATTENDED).ok).toBe(true);
    expect(notes.remove(own.id, ATTENDED)).toMatchObject({ ok: false, code: "not_found" });
    expect(notes.edit(999_999, "x", USER)).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("unverified lines", () => {
  it("stores a line added in an unattended turn as unverified, and one added in an attended turn as verified", () => {
    expect(added("from a report", UNATTENDED)).toMatchObject({ source: "assistant", unverified: true });
    expect(added("the user said so", ATTENDED)).toMatchObject({ source: "assistant", unverified: false });
  });

  it("marks a line unverified on an unattended edit, and the Assistant's own edit never clears the flag", () => {
    const own = added("release on friday", ATTENDED);
    expect(notes.edit(own.id, "release moved to monday", UNATTENDED)).toMatchObject({ ok: true, note: { unverified: true } });
    expect(notes.edit(own.id, "release on monday", ATTENDED)).toMatchObject({ ok: true, note: { unverified: true } });
  });

  it("clears the flag when the user edits the line in Settings, which makes the line theirs", () => {
    const own = added("from a report", UNATTENDED);
    expect(notes.edit(own.id, "checked: from a report", USER)).toMatchObject({ ok: true, note: { source: "user", unverified: false } });
    expect(notes.edit(own.id, "changed", ATTENDED)).toMatchObject({ ok: false, code: "locked" });
  });

  it("clears only the flag on Mark as verified", () => {
    const own = added("from a report", UNATTENDED);
    now += 60_000;
    expect(notes.markVerified(own.id)).toMatchObject({ ok: true, note: { source: "assistant", unverified: false, text: "from a report", updatedAt: own.updatedAt } });
    expect(notes.list().notes[0]).toMatchObject({ source: "assistant", unverified: false, updatedAt: own.updatedAt });
    expect(notes.markVerified(999_999)).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("announcing", () => {
  it("announces each change once and never a refused one", () => {
    const own = added("a", ATTENDED);
    notes.edit(own.id, "b", ATTENDED);
    notes.remove(own.id, ATTENDED);
    expect(announced).toBe(3);
    notes.add("", ATTENDED);
    notes.remove(own.id, ATTENDED);
    expect(announced).toBe(3);
  });
});
