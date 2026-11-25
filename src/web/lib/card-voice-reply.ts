/**
 * The decisions behind a spoken reply to a card, kept apart from React so they are tested on their
 * own: what the reply carries, and whether the mic may start. Sending, queueing and the auto-send
 * are the composer's (`voice-message-compose.ts`), reused as they are.
 *
 * A card reply is typed or spoken, never both: the server makes the whole text the transcript of
 * the voice part, so typed words sent beside a recording would be presented as said.
 */
import type { VoicePart } from "../../shared/voice-message";

/** What the card's reply route takes for a spoken reply. */
export interface CardVoiceReply {
  /** The transcript, as the user left it. */
  text: string;
  voice: { path: string; durationSec: number; receipt: string };
}

/**
 * The reply for a ready voice part, or null: with no receipt from the upload route the server
 * would refuse it, and an emptied transcript has nothing to say.
 */
export function cardVoiceReply(part: VoicePart, receipt: string | undefined): CardVoiceReply | null {
  if (!receipt || !part.transcript.trim()) return null;
  return { text: part.transcript, voice: { path: part.path, durationSec: part.durationSec, receipt } };
}

/**
 * A spoken answer moved into a card's field (the set of decisions, a question's Other), where the
 * user reads and edits it like typed words: what the reply route takes, plus what learning from
 * an edit compares the sent words with.
 */
export interface HeldVoice {
  path: string;
  durationSec: number;
  receipt: string;
  /** The transcript as PPM put it in the field. */
  shown: string;
  /** Whisper's own text, before the tidy-up. */
  raw?: string;
}

/** The part of a held voice the reply route takes. */
export const routeVoice = (held: HeldVoice): CardVoiceReply["voice"] =>
  ({ path: held.path, durationSec: held.durationSec, receipt: held.receipt });

export type CardMicState =
  | { kind: "hidden" }
  | { kind: "ready"; label: string }
  | { kind: "recording"; label: string }
  | { kind: "blocked"; label: string };

export const CARD_MIC_LABEL = "Answer by voice";
export const CARD_MIC_TYPED_REASON = "Answer by voice or in writing: clear the typed words to record";
export const CARD_MIC_DRAFT_REASON = "One voice message per reply. Remove this one to record another.";

/** What the mic beside a card's field shows. */
export function cardMicState(s: { enabled: boolean; typed: string; hasDraft: boolean; recording: boolean; hasImages?: boolean }): CardMicState {
  if (!s.enabled) return { kind: "hidden" };
  if (s.recording) return { kind: "recording", label: "Stop recording" };
  if (s.hasDraft) return { kind: "blocked", label: CARD_MIC_DRAFT_REASON };
  if (s.typed.trim() || s.hasImages) return { kind: "blocked", label: CARD_MIC_TYPED_REASON };
  return { kind: "ready", label: CARD_MIC_LABEL };
}
