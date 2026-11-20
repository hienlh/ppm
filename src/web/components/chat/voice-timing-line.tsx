/**
 * The line under a voice transcript: a short total (fits a 390 px phone) that opens into every
 * step with its seconds — the browser's conversion, the upload, the host's conversion, Whisper and
 * Claude Haiku — plus what happens next (read it, or it sends itself).
 */
import { useState } from "react";
import { ChevronDown, Sparkles } from "@/lib/icons";
import { timingRows, timingSummary, type VoiceTimings } from "@/lib/voice-message-timings";
import { cn } from "@/lib/utils";

export function VoiceTimingLine({ timings, next, fallback, original, onUseOriginal }: {
  timings?: VoiceTimings; next: string; fallback: string;
  /** Whisper's text before the clean-up, when it differs from what the box got. */
  original?: string | null;
  onUseOriginal?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  // A transcript from before step timings existed still says what it can.
  if (!timings) return <p className="flex items-center gap-1 text-[11px] text-text-3">{fallback}</p>;
  return (
    <div className="text-[11px] text-text-3">
      <div className="flex min-w-0 items-center gap-1">
        {timings.cleaned && <Sparkles className="size-3 shrink-0 text-accent-2" />}
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "Hide the time each step took" : "Show the time each step took"}
          onClick={() => setOpen((v) => !v)}
          className="-my-2 flex min-h-8 min-w-0 items-center gap-1 rounded px-1 hover:text-text-2 focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span className="truncate tabular-nums">{timingSummary(timings)}</span>
          <ChevronDown className={cn("size-3 shrink-0 transition-transform", open && "rotate-180")} />
        </button>
        <span className="hidden shrink-0 sm:inline">· {next}</span>
      </div>
      {open && (
        <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 rounded-md border border-border-soft bg-panel-2 px-2 py-1.5">
          {timingRows(timings).map((row) => (
            <div key={row.label} className="contents">
              <dt className={cn(row.label === "Total" && "font-medium text-text-2")}>{row.label}</dt>
              <dd className={cn("text-right tabular-nums", row.label === "Total" && "font-medium text-text-2")}>{row.value}</dd>
            </div>
          ))}
          <dt className="col-span-2 pt-0.5 sm:hidden">{next}</dt>
          {original && (
            <dd className="col-span-2 mt-1 border-t border-border-soft pt-1">
              <button
                type="button"
                aria-expanded={showOriginal}
                onClick={() => setShowOriginal((v) => !v)}
                className="flex min-h-8 items-center gap-1 text-text-2 hover:text-text"
              >
                <ChevronDown className={cn("size-3 transition-transform", showOriginal && "rotate-180")} />
                Whisper's original (before the tidy-up)
              </button>
              {showOriginal && (
                <div className="mt-1 space-y-1.5">
                  <p className="whitespace-pre-wrap break-words rounded border border-border-soft bg-panel px-2 py-1 text-[12px] leading-relaxed text-text-2 select-text">{original}</p>
                  {onUseOriginal && (
                    <button
                      type="button"
                      onClick={onUseOriginal}
                      className="min-h-8 rounded-md border border-border px-2.5 text-[11.5px] font-medium text-text-2 hover:bg-surface-hover hover:text-text"
                    >
                      Use the original
                    </button>
                  )}
                </div>
              )}
            </dd>
          )}
        </dl>
      )}
    </div>
  );
}
