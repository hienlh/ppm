/**
 * The composer's voice message as a chat draft keeps it, so a reload or another device brings the
 * voice chip and its transcript back. Stored in `chat_drafts.voice` as JSON beside the typed text.
 *
 * A draft is user data that every device of the user loads, so the server checks this shape before
 * storing it and the browser checks it again on the way back in: the path must be a recording PPM
 * itself stored (`isStoredVoicePath`), every field has its type, and text is held to a length.
 * Shared by server and browser, so nothing here may import from `src/services` or `src/web`.
 */
import { isStoredVoicePath } from "./voice-message";

/** The longest transcript (and Whisper / clean-up text) a draft keeps; longer is cut, like typed text. */
export const VOICE_DRAFT_MAX_TEXT = 20_000;
const MAX_ERROR = 2_000;
const MAX_PATH = 4_096;
/** Generous over the recorder's 120 s cap: a draft is never refused for a rounding of the length. */
const MAX_DURATION_SEC = 3_600;
/** Any step's milliseconds above a day are not a measurement. */
const MAX_MS = 86_400_000;

/** Each step's milliseconds, as the line under the transcript shows them. */
export interface StoredVoiceTimings {
  browserConvertMs: number;
  requestMs: number;
  serverMs?: number;
  receiveMs?: number;
  convertMs?: number;
  transcribeMs: number;
  cleanupMs: number;
  cleaned: boolean;
  cleanupSkipped?: boolean;
}

/** The transcript as it stood: present only once Whisper (and the clean-up) answered. */
export interface StoredVoiceTranscript {
  /** What is in the box now, edited or not; this is what a send would use. */
  text: string;
  /** What PPM put in the box (tidied, or raw when the clean-up failed or was off). */
  shown: string;
  /** Whisper's own text, before the clean-up. */
  raw?: string;
  cleaned: boolean;
  cleanupSkipped?: boolean;
  cleanupError?: string;
  transcribeMs: number;
  cleanupMs: number;
  timings?: StoredVoiceTimings;
}

/**
 * A voice draft exists only once its upload landed: without the file there is nothing to play or
 * send. No `transcript` means the page went away while it was still being transcribed.
 */
export interface StoredVoiceDraft {
  path: string;
  durationSec: number;
  transcript?: StoredVoiceTranscript;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const ms = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_MS ? v : null);
/** Cut, not refused: the user's words are worth more than the last characters of a huge paste. */
const text = (v: unknown, max: number): string | null => (typeof v === "string" ? v.slice(0, max) : null);

function parseTimings(v: unknown): StoredVoiceTimings | null {
  if (!isObj(v)) return null;
  const browserConvertMs = ms(v.browserConvertMs);
  const requestMs = ms(v.requestMs);
  const transcribeMs = ms(v.transcribeMs);
  const cleanupMs = ms(v.cleanupMs);
  if (browserConvertMs === null || requestMs === null || transcribeMs === null || cleanupMs === null) return null;
  if (typeof v.cleaned !== "boolean") return null;
  const out: StoredVoiceTimings = { browserConvertMs, requestMs, transcribeMs, cleanupMs, cleaned: v.cleaned };
  // The server's own figures are optional (an older server sends none); a wrong one is dropped alone.
  for (const key of ["serverMs", "receiveMs", "convertMs"] as const) {
    const value = ms(v[key]);
    if (value !== null) out[key] = value;
  }
  if (v.cleanupSkipped === true) out.cleanupSkipped = true;
  return out;
}

function parseTranscript(v: unknown): StoredVoiceTranscript | null {
  if (!isObj(v)) return null;
  const boxText = text(v.text, VOICE_DRAFT_MAX_TEXT);
  const shown = text(v.shown, VOICE_DRAFT_MAX_TEXT);
  const transcribeMs = ms(v.transcribeMs);
  const cleanupMs = ms(v.cleanupMs);
  if (boxText === null || shown === null || transcribeMs === null || cleanupMs === null) return null;
  if (typeof v.cleaned !== "boolean") return null;
  const out: StoredVoiceTranscript = { text: boxText, shown, cleaned: v.cleaned, transcribeMs, cleanupMs };
  const raw = text(v.raw, VOICE_DRAFT_MAX_TEXT);
  if (raw !== null) out.raw = raw;
  if (v.cleanupSkipped === true) out.cleanupSkipped = true;
  const cleanupError = text(v.cleanupError, MAX_ERROR);
  if (cleanupError) out.cleanupError = cleanupError;
  const timings = parseTimings(v.timings);
  if (timings) out.timings = timings;
  return out;
}

/**
 * The voice draft in `value`, or null when there is none or it is not one PPM wrote: a path that is
 * not a stored recording, a missing or mistyped field. A transcript that does not parse is dropped
 * alone, so the chip still comes back with "Transcribe again".
 */
export function parseStoredVoiceDraft(value: unknown): StoredVoiceDraft | null {
  if (!isObj(value)) return null;
  const { path, durationSec } = value;
  if (typeof path !== "string" || path.length > MAX_PATH || !isStoredVoicePath(path)) return null;
  if (typeof durationSec !== "number" || !Number.isFinite(durationSec) || durationSec < 0 || durationSec > MAX_DURATION_SEC) return null;
  const transcript = value.transcript === undefined ? null : parseTranscript(value.transcript);
  return transcript ? { path, durationSec, transcript } : { path, durationSec };
}

/** The stored JSON text, read back through the same check; anything unreadable is no voice. */
export function decodeStoredVoiceDraft(json: string | null | undefined): StoredVoiceDraft | null {
  if (!json) return null;
  try { return parseStoredVoiceDraft(JSON.parse(json)); } catch { return null; }
}
