/**
 * The voice part of a sent message, under whatever was typed: a divider, a player for the
 * uploaded recording and the transcript that was sent. Drawn from the marker in the message's
 * own text, so it comes back as it was after a reload.
 *
 * The uploads route takes the token as a header only, so the recording is fetched once with it
 * and played from a blob URL (`loadUploadedAudioUrl`), kept for the page's life.
 */
import { loadUploadedAudioUrl } from "@/lib/voice-upload-audio";
import type { VoicePart } from "../../../shared/voice-message";
import { uploadPreviewUrl } from "./message-media";
import { VoiceAudioPlayer } from "./voice-audio-player";

export function MessageVoicePart({ voice, projectName, divider }: { voice: VoicePart; projectName?: string; divider: boolean }) {
  const src = uploadPreviewUrl(voice.path, projectName);
  return (
    <div data-voice-part="">
      {divider && <div className="-mx-3 my-2 h-px bg-accent-wash-border" />}
      <VoiceAudioPlayer src={() => loadUploadedAudioUrl(src)} durationSec={voice.durationSec} bars={30} seed={voice.path} className="min-w-[210px] max-md:min-w-0" />
      {voice.transcript && (
        <p className="mt-1.5 whitespace-pre-wrap break-words select-text">{voice.transcript}</p>
      )}
    </div>
  );
}
