/**
 * The composer's bottom bar while a voice message is recording: Cancel, a pulsing dot, the time
 * against the 2:00 limit, live level bars and Stop, over a thin progress line. Esc cancels.
 *
 * The time, the levels and the progress line are written straight to the DOM on this bar's own
 * clock; a React state per frame here would re-render the whole composer sixty times a second.
 */
import { useEffect, useRef } from "react";
import { Square, X } from "@/lib/icons";
import { formatVoiceDuration, VOICE_MAX_SECONDS } from "../../../shared/voice-message";
import type { VoiceRecordingSession } from "@/hooks/use-voice-message-recorder";
import { ICON_CONTROL_SIZE } from "@/lib/control-size";

const BAR_COUNT = 28;
const COMPACT_ICON = `inline-flex ${ICON_CONTROL_SIZE} shrink-0 items-center justify-center rounded-full transition-colors`;

interface VoiceRecordingBarProps {
  session: VoiceRecordingSession;
  onStop: () => void;
  onCancel: () => void;
  /**
   * Inside a card's answer field: Cancel and Stop at the app's icon-button size (24px, 22px on a
   * phone) rather than the composer toolbar's, which the button standard leaves as it is for now.
   */
  compact?: boolean;
}

export function VoiceRecordingBar({ session, onStop, onCancel, compact }: VoiceRecordingBarProps) {
  const timeRef = useRef<HTMLSpanElement>(null);
  const progressRef = useRef<HTMLElement>(null);
  const barsRef = useRef<HTMLDivElement>(null);

  // Esc cancels the recording, from wherever focus is: the textarea keeps focus while recording.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  useEffect(() => {
    const { analyser, startedAt } = session;
    const data = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let raf = 0;
    let lastSecond = -1;
    const frame = () => {
      const elapsed = (performance.now() - startedAt) / 1000;
      const second = Math.floor(elapsed);
      if (second !== lastSecond && timeRef.current) {
        lastSecond = second;
        timeRef.current.textContent = formatVoiceDuration(second);
      }
      if (progressRef.current) progressRef.current.style.width = `${Math.min(100, (elapsed / VOICE_MAX_SECONDS) * 100)}%`;
      const bars = barsRef.current?.children;
      if (bars && analyser && data && !reduced) {
        analyser.getByteFrequencyData(data);
        for (let i = 0; i < bars.length; i++) {
          // The low bins carry speech; spread them over the bars.
          const level = (data[Math.floor((i / bars.length) * data.length * 0.6)] ?? 0) / 255;
          (bars[i] as HTMLElement).style.transform = `scaleY(${Math.max(0.15, level).toFixed(2)})`;
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [session]);

  return (
    <div data-voice-recording="" onClick={(e) => e.stopPropagation()}>
      <div className={compact ? "flex items-center gap-1.5 py-0.5" : "flex items-center gap-2 px-2 pb-1 pt-1"}>
        <button
          type="button"
          onClick={onCancel}
          className={compact
            ? `${COMPACT_ICON} text-text-3 can-hover:hover:bg-surface-hover can-hover:hover:text-text`
            : "flex size-11 shrink-0 items-center justify-center rounded-[10px] text-text-3 transition-colors can-hover:hover:bg-surface-hover can-hover:hover:text-text md:size-[34px]"}
          aria-label="Cancel recording"
          title="Cancel recording (Esc)"
        >
          <X className={compact ? "size-3.5" : "size-4"} />
        </button>
        <span className="size-[9px] shrink-0 rounded-full bg-error motion-safe:animate-pulse" aria-hidden />
        <span className="shrink-0 font-mono text-xs tabular-nums text-text" role="timer" aria-label="Recording time">
          <span ref={timeRef}>0:00</span>
          <span className="text-text-3"> / {formatVoiceDuration(VOICE_MAX_SECONDS)}</span>
        </span>
        <div ref={barsRef} className={`flex ${compact ? "h-5" : "h-[26px]"} min-w-0 flex-1 items-center justify-center gap-[2px] overflow-hidden`} aria-hidden>
          {Array.from({ length: BAR_COUNT }, (_, i) => (
            <i key={i} className="block h-full w-[3px] shrink-0 origin-center rounded-sm bg-error transition-transform duration-75" style={{ transform: "scaleY(0.15)" }} />
          ))}
        </div>
        <button
          type="button"
          onClick={onStop}
          className={compact
            ? `${COMPACT_ICON} bg-error text-white motion-safe:active:scale-[0.97]`
            : "flex size-11 shrink-0 items-center justify-center rounded-[11px] bg-error text-white shadow-[var(--shadow-float)] transition-transform motion-safe:active:scale-[0.97] md:size-9"}
          aria-label="Stop recording"
          title="Stop recording"
        >
          <Square className={compact ? "size-3.5" : "size-4"} />
        </button>
      </div>
      <div className={compact ? "mb-0.5 h-[3px] overflow-hidden rounded-sm bg-border-soft" : "mx-2.5 mb-2 h-[3px] overflow-hidden rounded-sm bg-border-soft"}>
        <i ref={progressRef} className="block h-full w-0 rounded-sm bg-error" />
      </div>
    </div>
  );
}
