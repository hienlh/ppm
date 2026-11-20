/**
 * The composer's voice draft to and from the chat draft (`StoredVoiceDraft`), kept apart from React
 * so the save and restore decisions can be tested:
 *
 * - saved once the upload landed, with the transcript once it is there (the box's current text,
 *   Whisper's and the clean-up's, the timings); before the upload landed there is nothing to keep;
 * - restored with a transcript: the chip and the block come back as they were, waiting to be read
 *   (a restored draft never sends itself, whatever the review setting says);
 * - restored without one (the page went while it was being transcribed): the chip alone, with
 *   "Transcribe again" running the pipeline on the uploaded file.
 */
import type { StoredVoiceDraft } from "../../shared/voice-draft";
import type { VoiceDraft } from "@/hooks/use-voice-message-draft";

export const VOICE_INTERRUPTED_MESSAGE = "The page was closed before this was transcribed.";

/** What the chat draft keeps of `draft`, with `text` as the transcript box holds it now. */
export function voiceDraftToStored(draft: VoiceDraft | null, text: string): StoredVoiceDraft | null {
  if (!draft || draft.upload.status !== "done" || !draft.upload.path) return null;
  const base: StoredVoiceDraft = { path: draft.upload.path, durationSec: draft.durationSec };
  const t = draft.transcript;
  if (t.status !== "ready") return base;
  return {
    ...base,
    transcript: {
      text, shown: t.shown, cleaned: t.cleaned, transcribeMs: t.transcribeMs, cleanupMs: t.cleanupMs,
      ...(t.raw !== undefined && { raw: t.raw }),
      ...(t.cleanupSkipped && { cleanupSkipped: true }),
      ...(t.cleanupError && { cleanupError: t.cleanupError }),
      ...(t.timings && { timings: t.timings }),
    },
  };
}

/**
 * The composer's draft for a stored voice, and the text its box starts with. `remoteSrc` is the
 * uploaded recording's URL: this browser holds no blob of it, so the chip plays that instead.
 */
export function voiceDraftFromStored(
  stored: StoredVoiceDraft,
  opts: { id: string; remoteSrc: string; now: number },
): { draft: VoiceDraft; text: string } {
  const base = {
    id: opts.id, remoteSrc: opts.remoteSrc, durationSec: stored.durationSec,
    upload: { status: "done" as const, path: stored.path },
  };
  const t = stored.transcript;
  if (!t) {
    return {
      text: "",
      draft: {
        ...base,
        transcript: {
          status: "error", startedAt: opts.now, shown: "", cleaned: false, transcribeMs: 0, cleanupMs: 0,
          interrupted: true, error: VOICE_INTERRUPTED_MESSAGE,
        },
      },
    };
  }
  return {
    text: t.text,
    draft: {
      ...base,
      transcript: {
        status: "ready", startedAt: opts.now, shown: t.shown, raw: t.raw, cleaned: t.cleaned,
        cleanupSkipped: t.cleanupSkipped, cleanupError: t.cleanupError,
        transcribeMs: t.transcribeMs, cleanupMs: t.cleanupMs, timings: t.timings,
        initialText: t.text,
        // Nobody pressed anything this time: it waits to be read, even with review off.
        reviewBeforeSend: true,
      },
    },
  };
}
