/**
 * The transcript of the composer's voice message: its own block under the typed text, marked
 * with a left accent bar and the label "Voice", never merged into what was typed. While Whisper
 * and the clean-up run it says so; then it is an ordinary text box the user reads and edits; a
 * failure says what failed and offers Retry and Remove.
 */
import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Loader2, Mic, RotateCw, Trash2 } from "@/lib/icons";
import { transcriptFooter } from "@/lib/voice-message-compose";
import { VoiceTimingLine } from "./voice-timing-line";
import { originalToShow } from "@/lib/voice-message-timings";
import type { VoiceDraft } from "@/hooks/use-voice-message-draft";
import { cn } from "@/lib/utils";
import { TEXT_CONTROL_HEIGHT } from "@/lib/control-size";

interface VoiceTranscriptBlockProps {
  draft: VoiceDraft;
  reviewBeforeSend: boolean;
  onTextChange: (text: string) => void;
  onRetry: () => void;
  onRemove: () => void;
  /** Enter in the transcript sends, as it does in the message box above. */
  onSubmit: () => void;
  disabled?: boolean;
  /** Send was pressed while it is being transcribed: it goes as soon as the text is there. */
  queued?: boolean;
  /** Inside a card's answer field: no side margins, and Retry/Remove at the app's button height. */
  compact?: boolean;
}

export function VoiceTranscriptBlock({ draft, reviewBeforeSend, onTextChange, onRetry, onRemove, onSubmit, disabled, queued, compact }: VoiceTranscriptBlockProps) {
  const { transcript, upload } = draft;
  // "Use the original" puts Whisper's text in the box: a new editor key re-seeds the uncontrolled box.
  const [seed, setSeed] = useState<{ n: number; text: string } | null>(null);
  const original = originalToShow(transcript);
  return (
    <div
      data-voice-transcript=""
      className={cn("flex flex-col gap-1 border-l-[3px] border-primary pl-2.5", compact ? "my-1" : "mx-3 mb-1 mt-2 md:mx-3.5")}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex flex-wrap items-center gap-1 text-[10.5px] font-semibold tracking-wide text-primary">
        {transcript.status === "processing" ? <Loader2 className="size-3 animate-spin" /> : <Mic className="size-3" />}
        Voice
        {transcript.status === "processing" && <ProcessingLabel startedAt={transcript.startedAt} />}
      </div>
      {transcript.status === "processing" && queued && (
        <p data-voice-queued="" className="text-[11px] font-medium text-primary">
          Sending when ready, without waiting to be read · press Send again to cancel
        </p>
      )}

      {transcript.status === "processing" && (
        <div className="flex flex-col gap-1.5 py-0.5" aria-hidden>
          <i className="block h-2.5 w-[94%] rounded bg-accent-wash-border motion-safe:animate-pulse" />
          <i className="block h-2.5 w-[55%] rounded bg-accent-wash-border motion-safe:animate-pulse" />
        </div>
      )}

      {transcript.status === "error" && (transcript.interrupted ? (
        // Restored from the chat's draft with no transcript: the recording is uploaded, so it can run again.
        <FailureNotice message={transcript.error ?? "Not transcribed yet."} retryLabel="Transcribe again" onRetry={onRetry} onRemove={onRemove} compact={compact} />
      ) : (
        <FailureNotice message={`Couldn't transcribe: ${transcript.error ?? "unknown error"}`} onRetry={onRetry} onRemove={onRemove} compact={compact} />
      ))}

      {transcript.status === "ready" && (
        <>
          {!transcript.cleaned && transcript.cleanupError && (
            <Notice>Couldn't tidy up: {transcript.cleanupError}. This is the raw transcript.</Notice>
          )}
          {upload.status === "error" && (
            <FailureNotice message="The recording could not be uploaded, so it cannot be sent yet." onRetry={onRetry} onRemove={onRemove} compact={compact} />
          )}
          <TranscriptEditor key={`${draft.id}:${seed?.n ?? 0}`} initial={seed?.text ?? transcript.initialText ?? transcript.shown} onChange={onTextChange} onSubmit={onSubmit} disabled={disabled} />
          <VoiceTimingLine
            timings={transcript.timings}
            next={reviewBeforeSend || !(transcript.cleaned || transcript.cleanupSkipped) ? "read it, then send" : "sending when ready"}
            fallback={transcriptFooter({ ...transcript, reviewBeforeSend })}
            original={original}
            onUseOriginal={original ? () => { setSeed((s) => ({ n: (s?.n ?? 0) + 1, text: original })); onTextChange(original); } : undefined}
          />
        </>
      )}
    </div>
  );
}

/** "Transcribing on this machine, then tidying up… 4s", the seconds counted here so the composer does not re-render. */
function ProcessingLabel({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <span role="status" className="ml-1 font-normal text-text-2">
      · Transcribing on this machine, then tidying up… <span className="tabular-nums">{seconds}s</span>
    </span>
  );
}

/** An auto-growing text box; the value is kept here so editing re-renders only this. */
function TranscriptEditor({ initial, onChange, onSubmit, disabled }: {
  initial: string; onChange: (text: string) => void; onSubmit: () => void; disabled?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
    <textarea
      value={value}
      disabled={disabled}
      rows={1}
      aria-label="Voice message transcript"
      onChange={(e) => { setValue(e.target.value); onChange(e.target.value); }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); onSubmit(); }
      }}
      className="block max-h-40 w-full resize-none bg-transparent py-0.5 text-sm leading-relaxed text-foreground focus:outline-none disabled:opacity-50 [field-sizing:content]"
    />
    {/* An emptied transcript is not sent: the message would say "transcribed below" over nothing. */}
    {!value.trim() && (
      <p role="status" data-voice-blank="" className="text-[11px] text-warning">Write something or remove the voice.</p>
    )}
    </>
  );
}

function Notice({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start gap-2 rounded-lg border border-warning/35 bg-warning/10 px-2.5 py-2 text-xs leading-snug text-text", className)}>
      <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function FailureNotice({ message, retryLabel = "Retry", onRetry, onRemove, compact }: {
  message: string; retryLabel?: string; onRetry: () => void; onRemove: () => void; compact?: boolean;
}) {
  const size = compact ? TEXT_CONTROL_HEIGHT : "min-h-11 md:min-h-8";
  return (
    <Notice>
      <p>{message}</p>
      <div className="mt-1.5 flex gap-2">
        <button type="button" onClick={onRetry} className={cn("inline-flex items-center gap-1 rounded-md px-2 font-medium text-primary can-hover:hover:bg-surface-hover", size)}>
          <RotateCw className="size-3.5" />{retryLabel}
        </button>
        <button type="button" onClick={onRemove} className={cn("inline-flex items-center gap-1 rounded-md px-2 text-text-2 can-hover:hover:bg-surface-hover", size)}>
          <Trash2 className="size-3.5" />Remove
        </button>
      </div>
    </Notice>
  );
}
