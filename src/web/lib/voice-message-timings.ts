/**
 * Where a voice message's wait went, step by step, for the line under the transcript: the browser's
 * conversion to WAV, the upload, the host's conversion, Whisper and Haiku. Everything but the upload
 * is measured where it runs; the upload is the request's round trip less the time the server spent
 * on the steps, so it also holds the reply's way back.
 */

export interface VoiceTimings {
  /** The browser re-encoding the recording as 16 kHz WAV. */
  browserConvertMs: number;
  /** From sending the request to the answer, as the browser saw it. */
  requestMs: number;
  /** The server's own figures (absent from an older server). */
  serverMs?: number;
  receiveMs?: number;
  convertMs?: number;
  transcribeMs: number;
  cleanupMs: number;
  /** Whether the clean-up gave the text: false when it failed, timed out or was refused. */
  cleaned: boolean;
  /** The chat box sends Whisper's text as heard, with hints (Settings → Voice), so Haiku never ran. */
  cleanupSkipped?: boolean;
}

export interface TimingRow { label: string; value: string }

const secs = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;

/** Upload plus the reply's way back: the round trip less the server's work after reading the body. */
export function uploadMs(t: VoiceTimings): number {
  if (t.serverMs === undefined) return Math.max(0, t.requestMs - t.transcribeMs - t.cleanupMs - (t.convertMs ?? 0));
  return Math.max(0, t.requestMs - (t.serverMs - (t.receiveMs ?? 0)));
}

/** Total from the moment recording stopped until the transcript was on screen. */
export function totalMs(t: VoiceTimings): number {
  return t.browserConvertMs + t.requestMs;
}

/** The short line: total, then the two steps that usually dominate. Fits a 390 px phone. */
export function timingSummary(t: VoiceTimings): string {
  const haiku = t.cleaned ? `Haiku ${secs(t.cleanupMs)}` : t.cleanupSkipped ? "as heard" : "Haiku didn't tidy";
  return `${secs(totalMs(t))} · Whisper ${secs(t.transcribeMs)} · ${haiku}`;
}

/**
 * Whisper's own text when the clean-up changed it, for the details to show; null when there is
 * nothing to compare (the clean-up was off or failed, so the box already holds Whisper's text).
 */
export function originalToShow(t: { cleaned: boolean; raw?: string; shown: string }): string | null {
  const raw = t.raw?.trim();
  return t.cleaned && raw && raw !== t.shown.trim() ? raw : null;
}

/** Every step with its seconds, for the details that open under the line. */
export function timingRows(t: VoiceTimings): TimingRow[] {
  return [
    { label: "Convert in the browser", value: secs(t.browserConvertMs) },
    { label: "Upload and reply", value: secs(uploadMs(t)) },
    { label: "Convert on the host", value: t.convertMs === undefined ? "—" : secs(t.convertMs) },
    { label: "Whisper (speech to text)", value: secs(t.transcribeMs) },
    { label: "Claude Haiku (tidy-up)", value: t.cleaned ? secs(t.cleanupMs) : t.cleanupSkipped ? "not used: sent as heard, with hints" : `didn't tidy after ${secs(t.cleanupMs)}` },
    { label: "Total", value: secs(totalMs(t)) },
  ];
}
