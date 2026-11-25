/**
 * The voice half of a card's answer field: the mic beside the field, and under it the recording
 * (Cancel, the clock, the levels, Stop) or the recording made — its player chip and the transcript
 * block, which the user reads or edits before it goes when "Read the transcript before sending" is
 * on. The pieces are the chat composer's own (`chat/voice-*.tsx`), in their compact form: in a card
 * every button keeps the app's standard sizes (24px icon buttons, 22px on a phone).
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Mic, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { ICON_CONTROL_SIZE } from "@/lib/control-size";
import { cardMicState, type HeldVoice } from "@/lib/card-voice-reply";
import { useCardVoiceReply, type CardVoiceReplyApi, type CardVoiceTarget } from "@/hooks/use-card-voice-reply";
import { VoiceRecordingBar } from "@/components/chat/voice-recording-bar";
import { VoiceMessageChip } from "@/components/chat/voice-message-chip";
import { VoiceTranscriptBlock } from "@/components/chat/voice-transcript-block";
import { VoiceWhisperMissingDialog } from "@/components/chat/voice-whisper-missing-dialog";
import { VoiceAudioPlayer } from "@/components/chat/voice-audio-player";
import { uploadPreviewUrl } from "@/components/chat/message-media";
import { loadUploadedAudioUrl } from "@/lib/voice-upload-audio";

export function CardVoiceMicButton({ voice, typed, hasImages, disabled, className }: {
  voice: CardVoiceReplyApi;
  typed: string;
  hasImages?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const state = cardMicState({ enabled: voice.enabled, typed, hasDraft: !!voice.draft, recording: voice.recording, hasImages });
  if (state.kind === "hidden") return null;
  const blocked = state.kind === "blocked";
  return (
    <button
      type="button"
      data-card-voice-mic={state.kind}
      onClick={(e) => { e.stopPropagation(); if (!blocked) void voice.toggle(); }}
      disabled={disabled}
      aria-disabled={blocked || undefined}
      aria-label={state.label}
      title={state.label}
      className={cn(
        `inline-grid ${ICON_CONTROL_SIZE} shrink-0 place-items-center rounded-full text-text-secondary transition-colors`,
        "can-hover:enabled:hover:bg-surface-elevated can-hover:enabled:hover:text-text-primary disabled:opacity-40 [&_svg]:size-3.5",
        blocked && "cursor-not-allowed opacity-40",
        state.kind === "recording" && "bg-error text-white can-hover:enabled:hover:bg-error can-hover:enabled:hover:text-white",
        className,
      )}
    >
      <Mic />
    </button>
  );
}

/** The recording in progress, or the voice waiting to go, under the card's field. */
export function CardVoiceDraftArea({ voice, onSubmit, disabled }: { voice: CardVoiceReplyApi; onSubmit: () => void; disabled?: boolean }) {
  return (
    <>
      {voice.recording && voice.session && (
        <div data-card-voice-recording="">
          <VoiceRecordingBar compact session={voice.session} onStop={voice.stopRecording} onCancel={voice.cancelRecording} />
        </div>
      )}
      {voice.draft && (
        <div className="flex min-w-0 flex-col gap-1" data-card-voice-draft={voice.gate}>
          <VoiceMessageChip draft={voice.draft} onRemove={voice.remove} />
          <VoiceTranscriptBlock
            compact
            draft={voice.draft}
            reviewBeforeSend={voice.reviewBeforeSend || voice.stalled}
            onTextChange={voice.setText}
            onRetry={voice.retry}
            onRemove={voice.remove}
            onSubmit={onSubmit}
            disabled={disabled}
            queued={voice.queued}
          />
        </div>
      )}
      <VoiceWhisperMissingDialog open={voice.whisperDialogOpen} onClose={voice.closeWhisperDialog} />
    </>
  );
}

/**
 * Recording into a field that keeps its own answer (the set of decisions' Other, a question's
 * Other): once the transcript and the upload are both in, the words leave the voice draft for the
 * field — where the user reads and edits them, as "Read the transcript before sending" asks — and
 * `onReady` says whether they may go at once (review off, the tidy-up done). A question's answer
 * is plain text, so there the recording is deleted (`discardAfter`); elsewhere it stays for the
 * reply that names it.
 */
export function CardVoiceCapture({ target, typed, hasImages, disabled, discardAfter, onReady, children }: {
  target: CardVoiceTarget;
  typed: string;
  hasImages?: boolean;
  disabled?: boolean;
  discardAfter?: boolean;
  onReady: (held: HeldVoice & { text: string }, autoSend: boolean) => void;
  /** `on`: voice messages work here (or a recording is under way); off, the field is drawn as it is without them. */
  children: (parts: { mic: ReactNode; area: ReactNode; on: boolean }) => ReactNode;
}) {
  const typedRef = useRef(typed);
  typedRef.current = typed;
  // Nothing is sent from the voice draft itself here: its words are handed to the field.
  const voice = useCardVoiceReply({ card: target, getTyped: () => typedRef.current, send: () => {}, blocked: true });
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const { gate, draft, reply, autoSendReady, sent, remove } = voice;
  useEffect(() => {
    if (gate !== "ready" || !draft) return;
    const spoken = reply();
    if (!spoken) return;
    onReadyRef.current({ ...spoken.voice, text: spoken.text, shown: draft.transcript.shown, raw: draft.transcript.raw }, autoSendReady);
    if (discardAfter) remove(); else sent();
  }, [gate, draft, reply, autoSendReady, sent, remove, discardAfter]);
  return <>{children({
    mic: <CardVoiceMicButton voice={voice} typed={typed} hasImages={hasImages} disabled={disabled} />,
    area: <CardVoiceDraftArea voice={voice} onSubmit={() => {}} disabled={disabled} />,
    on: voice.enabled || voice.recording || !!draft,
  })}</>;
}

/**
 * A spoken answer held in a field: the recording's player and a × that keeps the words but drops
 * the recording (they then go as typed words). The words themselves are in the field.
 */
export function HeldVoiceChip({ held, projectName, onDrop, disabled }: {
  held: HeldVoice; projectName: string | null; onDrop: () => void; disabled?: boolean;
}) {
  return (
    <div className="flex w-52 max-w-full items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-secondary" data-card-held-voice="">
      <Mic className="size-3 shrink-0 text-primary" aria-label="Voice reply" />
      <VoiceAudioPlayer
        src={() => loadUploadedAudioUrl(uploadPreviewUrl(held.path, projectName ?? undefined))}
        durationSec={held.durationSec} bars={12} size="sm" seed={held.path}
      />
      <button
        type="button"
        onClick={onDrop}
        disabled={disabled}
        aria-label="Send as typed words, without the recording"
        title="Send as typed words, without the recording"
        className={`inline-grid ${ICON_CONTROL_SIZE} shrink-0 place-items-center rounded-full transition-colors can-hover:enabled:hover:bg-surface-elevated [&_svg]:size-3`}
      >
        <X />
      </button>
    </div>
  );
}
