/**
 * What the Telegram bridge needs from PPM's voice-message pipeline, behind one interface so tests
 * can stand in for Whisper and Haiku.
 *
 * The pipeline is loaded on first use rather than imported: it pulls in Whisper, ffmpeg and the
 * Claude clean-up, none of which a bridge without a voice message ever needs.
 */
import { configService } from "../config.service.ts";
import type { LearnedWord } from "../../shared/voice-message.ts";

export interface VoiceProcessInput {
  audio: Uint8Array;
  project: string;
  sessionId?: string;
  providerId?: string;
  typed?: string;
  lang?: string;
}

export interface VoiceProcessResult {
  raw: string;
  text: string;
  cleaned: boolean;
  cleanupError?: string;
  /** The Haiku clean-up is turned off: Whisper's text, by choice. */
  cleanupSkipped?: true;
  transcribeMs: number;
  cleanupMs: number;
}

export interface TelegramVoiceDeps {
  /** The feature's switch (`voice_message.enabled`); off means voice messages are refused as before. */
  enabled(): boolean;
  /** Wait for the user to read the transcript before sending. */
  reviewBeforeSend(): boolean;
  /** Throws with `code` "whisper_missing" / "ffmpeg_missing" / … when it cannot read the audio. */
  process(input: VoiceProcessInput): Promise<VoiceProcessResult>;
  /** The corrections learned from the user editing a transcript (only the new ones). */
  learn(input: { project: string; before: string; after: string }): Promise<LearnedWord[]>;
}

/** The real pipeline, as configured in Settings → Voice. */
export const defaultTelegramVoiceDeps: TelegramVoiceDeps = {
  enabled: () => configService.get("voice_message")?.enabled === true,
  reviewBeforeSend: () => configService.get("voice_message")?.review_before_send !== false,
  async process(input) {
    const { processVoiceMessage } = await import("../voice-message/voice-message.service.ts");
    return processVoiceMessage(input);
  },
  async learn(input) {
    const { learnFromEdit } = await import("../voice-message/voice-message.service.ts");
    return learnFromEdit(input);
  },
};
