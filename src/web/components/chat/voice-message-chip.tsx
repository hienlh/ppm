/**
 * The voice message waiting in the composer, as a chip in the attachment row beside any image:
 * play the recording, its length, and × to drop it (the transcript block goes with it).
 */
import { AlertTriangle, Loader2, X } from "@/lib/icons";
import { usePrefersCoarsePointer } from "@/components/os-explorer/use-coarse-long-press";
import { cn } from "@/lib/utils";
import type { VoiceDraft } from "@/hooks/use-voice-message-draft";
import { loadUploadedAudioUrl } from "@/lib/voice-upload-audio";
import { VoiceAudioPlayer } from "./voice-audio-player";

/**
 * The recording in this browser when there is one; a draft that came back from storage (a reload,
 * another device) has only the uploaded copy, fetched with the token on the first play.
 */
function draftAudioSource(draft: VoiceDraft): string | (() => Promise<string>) {
  if (draft.localUrl) return draft.localUrl;
  const remote = draft.remoteSrc;
  return remote ? () => loadUploadedAudioUrl(remote) : () => Promise.reject(new Error("No recording"));
}

export function VoiceMessageChip({ draft, onRemove }: { draft: VoiceDraft; onRemove: () => void }) {
  const coarse = usePrefersCoarsePointer();
  const busy = draft.transcript.status === "processing" || draft.upload.status === "uploading";
  const failed = draft.transcript.status === "error" || draft.upload.status === "error";
  return (
    <div
      data-voice-chip=""
      className={cn(
        "flex w-52 max-w-full items-center gap-1.5 rounded-md border bg-surface px-2 py-1 text-xs text-text-secondary",
        failed ? "border-warning/50" : busy ? "border-accent-wash-border" : "border-border",
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <VoiceAudioPlayer src={draftAudioSource(draft)} durationSec={draft.durationSec} bars={12} size="sm" seed={draft.id} />
      {failed ? (
        <AlertTriangle className="size-3 shrink-0 text-warning" aria-label="Something failed, see below" />
      ) : busy ? (
        <Loader2 className="size-3 shrink-0 animate-spin text-text-subtle" aria-label="Working on it" />
      ) : null}
      {/* Same target arithmetic as the other chips' remove buttons: 44px tall on a coarse pointer. */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className={cn(
          "relative shrink-0 rounded-sm p-0.5 transition-colors hover:bg-border/50",
          coarse && "before:absolute before:-inset-y-3.5 before:-inset-x-1.5 before:content-['']",
        )}
        aria-label="Remove voice message"
        title="Remove voice message"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
