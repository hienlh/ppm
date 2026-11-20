/**
 * Why a voice message could not be turned into text. A failed clean-up is not one of these: it
 * still has the raw transcript to offer, so it comes back as `cleaned: false` instead.
 */
export type VoiceMessageErrorCode =
  | "whisper_missing"
  | "ffmpeg_missing"
  | "invalid_project"
  | "empty_audio"
  | "too_long"
  | "unreadable_audio"
  | "transcribe_failed";

/** `message` is a sentence a person can read; `code` is what callers branch on. */
export class VoiceMessageError extends Error {
  readonly code: VoiceMessageErrorCode;
  constructor(code: VoiceMessageErrorCode, message: string) {
    super(message);
    this.name = "VoiceMessageError";
    this.code = code;
  }
}
