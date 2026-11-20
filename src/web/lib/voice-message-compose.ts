/**
 * The composer's voice-message decisions, kept apart from React so they can be tested: what the
 * message text becomes, whether the send button may send, queue or must wait, whether a ready
 * draft sends itself, and whether the user changed the transcript PPM gave them.
 */
import { encodeVoicePart, type VoicePart } from "../../shared/voice-message";

/** Where one recording is: its transcript and its upload run side by side. */
export interface VoiceDraftProgress {
  transcript: "processing" | "ready" | "error";
  upload: "uploading" | "done" | "error";
  /** The clean-up ran; false means the box holds the raw transcript, which always waits for review. */
  cleaned: boolean;
}

/** One state the send button can be in because of the voice draft. */
export type VoiceGate = "none" | "transcribing" | "uploading" | "ready" | "failed";

export function voiceGate(draft: VoiceDraftProgress | null): VoiceGate {
  if (!draft) return "none";
  if (draft.transcript === "error" || draft.upload === "error") return "failed";
  if (draft.transcript === "processing") return "transcribing";
  if (draft.upload === "uploading") return "uploading";
  return "ready";
}

export interface VoiceSendOptions {
  /** The setting "Read the transcript before it is sent", as the server last answered it. */
  reviewBeforeSend: boolean;
  /** The clean-up ran; false means the box holds the raw transcript, which never goes out unread. */
  cleaned: boolean;
  /**
   * Re-checking a send that was queued while the transcript was not in the box yet: nobody has
   * read what is there now. A send queued after the text was shown (only the upload was
   * outstanding) was pressed by someone looking at it, and is false here.
   */
  queuedBeforeText: boolean;
  /** The user emptied the transcript block: a voice part saying "transcribed below" over nothing. */
  transcriptBlank?: boolean;
}

/**
 * What pressing send (or re-checking a send already queued) does about the voice draft:
 * - `send`: go now;
 * - `queue`: remember the press and go once the draft is ready;
 * - `hold`: do nothing and wait for the user — review is on and the text is not there yet, a
 *   queued send met a transcript nobody has read (raw, or review turned on meanwhile), or the
 *   transcript was emptied;
 * - `refuse`: the draft failed; a voice whose upload or transcript failed is never sent.
 */
export function decideVoiceSend(gate: VoiceGate, opts: VoiceSendOptions): "send" | "queue" | "hold" | "refuse" {
  switch (gate) {
    case "none":
      return "send";
    case "failed":
      return "refuse";
    case "uploading":
      // The transcript is in the box already; only the file is still on its way.
      return opts.transcriptBlank ? "hold" : "queue";
    case "transcribing":
      return opts.reviewBeforeSend ? "hold" : "queue";
    case "ready":
      if (opts.transcriptBlank) return "hold";
      // Pressed before any text was shown: only a tidied transcript with review off may go unread.
      if (opts.queuedBeforeText && (opts.reviewBeforeSend || !opts.cleaned)) return "hold";
      return "send";
  }
}

/** With review off, a draft that is ready and was tidied sends the whole message by itself. */
export function shouldAutoSend(gate: VoiceGate, opts: { reviewBeforeSend: boolean; cleaned: boolean }): boolean {
  return gate === "ready" && !opts.reviewBeforeSend && opts.cleaned;
}

/**
 * The auto-send's next step for one draft: `send` it now, `wait` while the composer cannot send
 * (disabled, a turn chip still loading, …) and try again once it can, or `idle` (nothing to send,
 * already tried for this draft, or a send is already queued).
 */
export function autoSendStep(s: {
  ready: boolean; draftId: string | null; attemptedId: string | null; queued: boolean; blocked: boolean;
}): "send" | "wait" | "idle" {
  if (!s.draftId || !s.ready || s.attemptedId === s.draftId || s.queued) return "idle";
  return s.blocked ? "wait" : "send";
}

/** The message text: what was typed, then the voice part, which always comes last. */
export function composeVoiceContent(typed: string, voice: VoicePart | null): string {
  if (!voice) return typed;
  const part = encodeVoicePart(voice);
  const head = typed.trim();
  return head ? `${head}\n\n${part}` : part;
}

/** Whether the user changed the transcript before sending. Whitespace alone is not a change. */
export function transcriptWasEdited(shown: string, sent: string, raw?: string): boolean {
  const norm = (text: string) => text.replace(/\s+/g, " ").trim();
  const a = norm(shown);
  const b = norm(sent);
  // Sending Whisper's own text ("Use the original") is not a correction: learning from it would
  // record the misheard words as the right ones.
  if (raw !== undefined && norm(raw) === b) return false;
  return a.length > 0 && b.length > 0 && a !== b;
}

/** The upload's file name: `voice-<timestamp>.<ext>`, the extension read from the recorder's type. */
export function voiceFileName(mimeType: string, now: Date = new Date()): string {
  const type = mimeType.toLowerCase();
  const ext = type.includes("webm") ? "webm"
    : type.includes("ogg") ? "ogg"
    : type.includes("mp4") || type.includes("aac") || type.includes("m4a") ? "m4a"
    : type.includes("wav") ? "wav"
    : "webm";
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  return `voice-${stamp}.${ext}`;
}

/** "Transcribed 2.8s · tidied 1.1s · read it, then send", or what is true when the clean-up failed. */
export function transcriptFooter(input: { transcribeMs: number; cleanupMs: number; cleaned: boolean; reviewBeforeSend: boolean }): string {
  const secs = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  const parts = [`Transcribed ${secs(input.transcribeMs)}`];
  if (input.cleaned) parts.push(`tidied ${secs(input.cleanupMs)}`);
  parts.push(input.reviewBeforeSend || !input.cleaned ? "read it, then send" : "sending when ready");
  return parts.join(" · ");
}

/**
 * What a failed transcript request means for the draft, by the server's code (never by the
 * status alone — a 409 is also "voice messages are turned off"):
 * - `whisper-missing`: drop the draft and offer to install Whisper;
 * - `turned-off`: the feature was switched off (on another device, say): say so, and keep the
 *   draft as a failure the user can remove;
 * - `failed`: an ordinary failure, shown on the block with Retry and Remove.
 */
export function transcriptFailureAction(code: string | undefined): "whisper-missing" | "turned-off" | "failed" {
  if (code === "whisper_missing") return "whisper-missing";
  if (code === "voice_messages_off") return "turned-off";
  return "failed";
}
