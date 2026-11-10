import { getDb } from "../db.service.ts";
import { NOTE_SOURCES, type AssistantNote, type NoteSource } from "../../shared/assistant-notes.ts";

/**
 * Storage for PPM Assistant's notebook (`assistant_notes`, migration 66). Plain rows: the rules
 * (who may change which line, the caps, the unverified flag) are `assistant-notes.service.ts`'s,
 * which runs each check and its write in one transaction.
 */

interface Raw {
  id: number; text: string; source: string; unverified: number; created_at: number; updated_at: number;
}

const toNote = (r: Raw): AssistantNote => ({
  id: r.id,
  text: r.text,
  // The table's CHECK allows only these two; anything else would be a hand-edited row.
  source: (NOTE_SOURCES as readonly string[]).includes(r.source) ? r.source as NoteSource : "assistant",
  unverified: r.unverified !== 0,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Every line, oldest first. */
export function listNoteRows(): AssistantNote[] {
  return (getDb().query("SELECT * FROM assistant_notes ORDER BY id").all() as Raw[]).map(toNote);
}

export function getNoteRow(id: number): AssistantNote | null {
  const row = getDb().query("SELECT * FROM assistant_notes WHERE id = ?").get(id) as Raw | null;
  return row ? toNote(row) : null;
}

/**
 * Characters used by every line's text, with `exceptId`'s line left out when given. Counted in
 * JS (`String#length`) rather than SQLite's `LENGTH`, which counts code points, so the cap means
 * the same number here, in the tools and in Settings' meter.
 */
export function usedNoteChars(exceptId?: number): number {
  const rows = getDb().query("SELECT text FROM assistant_notes WHERE id != ?").all(exceptId ?? -1) as Array<{ text: string }>;
  return rows.reduce((sum, r) => sum + r.text.length, 0);
}

export function insertNoteRow(text: string, source: NoteSource, unverified: boolean, at: number): number {
  const result = getDb().query(
    "INSERT INTO assistant_notes (text, source, unverified, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(text, source, unverified ? 1 : 0, at, at);
  return Number(result.lastInsertRowid);
}

export function updateNoteRow(id: number, fields: { text: string; source: NoteSource; unverified: boolean }, at: number): void {
  getDb().query("UPDATE assistant_notes SET text = ?, source = ?, unverified = ?, updated_at = ? WHERE id = ?")
    .run(fields.text, fields.source, fields.unverified ? 1 : 0, at, id);
}

/** Clears the unverified flag and nothing else: the line keeps its text, source and date. */
export function clearNoteUnverified(id: number): void {
  getDb().query("UPDATE assistant_notes SET unverified = 0 WHERE id = ?").run(id);
}

export function deleteNoteRow(id: number): void {
  getDb().query("DELETE FROM assistant_notes WHERE id = ?").run(id);
}

/** `fn` inside one write transaction, so a check and the write it allows cannot interleave. */
export function inNotesTransaction<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}
