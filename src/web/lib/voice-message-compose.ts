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

/**
 * What pressing send (or re-checking a send already queued) does about the voice draft:
 * - `send`: go now;
 * - `queue`: remember the press and go once the draft is ready;
 * - `hold`: do nothing and wait for the user (review is on and the text is not there yet, or a
 *   queued send met a raw transcript, which is never sent unread);
 * - `refuse`: the draft failed; a voice whose upload or transcript failed is never sent.
 */
export function decideVoiceSend(
  gate: VoiceGate,
  opts: { reviewBeforeSend: boolean; cleaned: boolean; queued: boolean },
): "send" | "queue" | "hold" | "refuse" {
  switch (gate) {
    case "none":
      return "send";
    case "failed":
      return "refuse";
    case "uploading":
      // The transcript is in the box already; only the file is still on its way.
      return "queue";
    case "transcribing":
      return opts.reviewBeforeSend ? "hold" : "queue";
    case "ready":
      // Queued before the text existed, with review off: a raw transcript still waits to be read.
      if (opts.queued && !opts.reviewBeforeSend && !opts.cleaned) return "hold";
      return "send";
  }
}

/** With review off, a draft that is ready and was tidied sends the whole message by itself. */
export function shouldAutoSend(gate: VoiceGate, opts: { reviewBeforeSend: boolean; cleaned: boolean }): boolean {
  return gate === "ready" && !opts.reviewBeforeSend && opts.cleaned;
}

/** The message text: what was typed, then the voice part, which always comes last. */
export function composeVoiceContent(typed: string, voice: VoicePart | null): string {
  if (!voice) return typed;
  const part = encodeVoicePart(voice);
  const head = typed.trim();
  return head ? `${head}\n\n${part}` : part;
}

/** Whether the user changed the transcript before sending. Whitespace alone is not a change. */
export function transcriptWasEdited(shown: string, sent: string): boolean {
  const norm = (text: string) => text.replace(/\s+/g, " ").trim();
  const a = norm(shown);
  const b = norm(sent);
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
