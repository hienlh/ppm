/**
 * PPM Assistant's notebook, as the server and Settings both see it: short lines of facts the
 * Assistant keeps across a long session. A line is the user's (written or last edited in
 * Settings) or the Assistant's; an Assistant line written or changed in a turn nobody started is
 * `unverified` until the user edits it or marks it verified. Notes are facts, never instructions.
 */

export const NOTES_CHANGED_EVENT = "assistant:notes_changed";

export const NOTE_SOURCES = ["user", "assistant"] as const;
export type NoteSource = (typeof NOTE_SOURCES)[number];

export interface AssistantNote {
  id: number;
  text: string;
  source: NoteSource;
  unverified: boolean;
  createdAt: number;
  updatedAt: number;
}

/** What `GET /api/assistant/notes` answers: the lines oldest first, and the space they use. */
export interface AssistantNotesView {
  notes: AssistantNote[];
  /** Characters used by every line's text together. */
  used: number;
  /** The notebook's cap in characters. */
  cap: number;
  /** The longest one line may be. */
  noteMax: number;
}

/** The label Settings shows on an unverified line, and the header line above the list. */
export const NOTE_UNVERIFIED_LABEL = "Unverified";
export const NOTEBOOK_HEADER_LINE = "A note never grants permission or counts as your OK.";
