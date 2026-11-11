/**
 * PPM Assistant's notebook: the rules every write goes through, whoever writes.
 *
 * - The whole notebook holds at most {@link NOTEBOOK_CAP_CHARS} characters and one line at most
 *   {@link NOTE_MAX_CHARS}; a write that would pass either is refused, never cut.
 * - The user (Settings) may add, edit, delete and verify any line. A line the user adds or edits
 *   becomes theirs (`source = 'user'`) and verified.
 * - The Assistant may add lines and edit or delete its own. A line the user wrote is read-only to
 *   it. A line it adds or edits in a turn nobody started is unverified, and its own edit never
 *   clears that flag: only the user verifies.
 *
 * Every check runs in the same transaction as the write it allows, and every change is announced
 * as `assistant:notes_changed`.
 */
import { assistantClock } from "../assistant-wake/assistant-clock.ts";
import { createLogger } from "../logger.ts";
import { NOTEBOOK_CAP_CHARS, NOTEBOOK_USER_RESERVE_CHARS, NOTE_MAX_CHARS } from "../../shared/assistant-limits.ts";
import type { AssistantNote, AssistantNotesView } from "../../shared/assistant-notes.ts";
import {
  clearNoteUnverified, deleteNoteRow, getNoteRow, inNotesTransaction, insertNoteRow, listNoteRows, updateNoteRow,
  usedNoteChars,
} from "./assistant-notes-db.ts";

const log = createLogger("assistant-notes");

/** Who is writing: the user from Settings, or the Assistant from a turn the user did or did not start. */
export type NoteWriter = { by: "user" } | { by: "assistant"; unattended: boolean };

export type NoteErrorCode = "empty" | "too_long" | "full" | "not_found" | "locked";
export type NoteResult = { ok: true; note: AssistantNote } | { ok: false; code: NoteErrorCode; error: string };

export const NOTE_LOCKED = "The user wrote this line; propose the change to them instead.";

export interface AssistantNotesEnv {
  now(): number;
  announce(): void;
}

const defaultEnv: AssistantNotesEnv = {
  now: () => assistantClock.now(),
  announce: () => {
    void import("./assistant-notes-announce.ts").then(({ announceNotesChanged }) => announceNotesChanged()).catch(() => {});
  },
};

/**
 * One line: every run of whitespace (line breaks and line separators included, which `\s`
 * matches) becomes one space, and the ends are trimmed. Anything else is kept as written.
 */
export function normalizeNoteText(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
}

const fail = (code: NoteErrorCode, error: string): NoteResult => ({ ok: false, code, error });

/**
 * Text a line may hold, or why not, given the characters every other line uses. The Assistant
 * stops {@link NOTEBOOK_USER_RESERVE_CHARS} short of the cap, so it can never fill the notebook to
 * the point where the user has no room left to write a line of their own.
 */
function checkText(text: string, usedByOthers: number, writer: NoteWriter): NoteResult | null {
  if (!text) return fail("empty", "A note needs some text.");
  if (text.length > NOTE_MAX_CHARS) {
    return fail("too_long", `A note is at most ${NOTE_MAX_CHARS} characters; this one has ${text.length}. Shorten it.`);
  }
  const cap = writer.by === "user" ? NOTEBOOK_CAP_CHARS : NOTEBOOK_CAP_CHARS - NOTEBOOK_USER_RESERVE_CHARS;
  if (usedByOthers + text.length > cap) {
    const whose = writer.by === "user" ? "" : " (the rest is kept for the user's own lines)";
    return fail("full", `The notebook holds at most ${cap} characters of these lines${whose}; ${usedByOthers} are used by other lines `
      + `and this line has ${text.length}. Delete or shorten old lines first.`);
  }
  return null;
}

export function createAssistantNotes(env: AssistantNotesEnv = defaultEnv) {
  /** Runs one change; announces it only when it happened. */
  const change = (what: string, fn: () => NoteResult): NoteResult => {
    const result = inNotesTransaction(fn);
    if (result.ok) {
      log.info(`note #${result.note.id} ${what} (${result.note.source}${result.note.unverified ? ", unverified" : ""})`);
      env.announce();
    }
    return result;
  };

  return {
    list(): AssistantNotesView {
      const notes = listNoteRows();
      return { notes, used: notes.reduce((n, l) => n + l.text.length, 0), cap: NOTEBOOK_CAP_CHARS, noteMax: NOTE_MAX_CHARS };
    },

    add(raw: unknown, writer: NoteWriter): NoteResult {
      const text = normalizeNoteText(raw);
      return change("added", () => {
        const refused = checkText(text, usedNoteChars(), writer);
        if (refused) return refused;
        const unverified = writer.by === "assistant" && writer.unattended;
        const id = insertNoteRow(text, writer.by, unverified, env.now());
        return { ok: true, note: getNoteRow(id)! };
      });
    },

    edit(id: number, raw: unknown, writer: NoteWriter): NoteResult {
      const text = normalizeNoteText(raw);
      return change("edited", () => {
        const note = getNoteRow(id);
        if (!note) return fail("not_found", `No note #${id}.`);
        if (writer.by === "assistant" && note.source === "user") return fail("locked", NOTE_LOCKED);
        const refused = checkText(text, usedNoteChars(id), writer);
        if (refused) return refused;
        const fields = writer.by === "user"
          ? { text, source: "user" as const, unverified: false }
          : { text, source: "assistant" as const, unverified: note.unverified || writer.unattended };
        updateNoteRow(id, fields, env.now());
        return { ok: true, note: getNoteRow(id)! };
      });
    },

    remove(id: number, writer: NoteWriter): NoteResult {
      return change("deleted", () => {
        const note = getNoteRow(id);
        if (!note) return fail("not_found", `No note #${id}.`);
        if (writer.by === "assistant" && note.source === "user") return fail("locked", NOTE_LOCKED);
        deleteNoteRow(id);
        return { ok: true, note };
      });
    },

    /** The user's "Mark as verified": clears the flag and changes nothing else. */
    markVerified(id: number): NoteResult {
      return change("verified", () => {
        const note = getNoteRow(id);
        if (!note) return fail("not_found", `No note #${id}.`);
        clearNoteUnverified(id);
        return { ok: true, note: { ...note, unverified: false } };
      });
    },
  };
}

export type AssistantNotes = ReturnType<typeof createAssistantNotes>;

export const assistantNotes = createAssistantNotes();
