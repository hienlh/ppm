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

const BAR_COUNT = 28;

interface VoiceRecordingBarProps {
  session: VoiceRecordingSession;
  onStop: () => void;
  onCancel: () => void;
}

export function VoiceRecordingBar({ session, onStop, onCancel }: VoiceRecordingBarProps) {
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
      <div className="flex items-center gap-2 px-2 pb-1 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="flex size-11 shrink-0 items-center justify-center rounded-[10px] text-text-3 transition-colors can-hover:hover:bg-surface-hover can-hover:hover:text-text md:size-[34px]"
          aria-label="Cancel recording"
          title="Cancel recording (Esc)"
        >
          <X className="size-4" />
        </button>
        <span className="size-[9px] shrink-0 rounded-full bg-error motion-safe:animate-pulse" aria-hidden />
        <span className="shrink-0 font-mono text-xs tabular-nums text-text" role="timer" aria-label="Recording time">
          <span ref={timeRef}>0:00</span>
          <span className="text-text-3"> / {formatVoiceDuration(VOICE_MAX_SECONDS)}</span>
        </span>
        <div ref={barsRef} className="flex h-[26px] min-w-0 flex-1 items-center justify-center gap-[2px] overflow-hidden" aria-hidden>
          {Array.from({ length: BAR_COUNT }, (_, i) => (
            <i key={i} className="block h-full w-[3px] shrink-0 origin-center rounded-sm bg-error transition-transform duration-75" style={{ transform: "scaleY(0.15)" }} />
          ))}
        </div>
        <button
          type="button"
          onClick={onStop}
          className="flex size-11 shrink-0 items-center justify-center rounded-[11px] bg-error text-white shadow-[var(--shadow-float)] transition-transform motion-safe:active:scale-[0.97] md:size-9"
          aria-label="Stop recording"
          title="Stop recording"
        >
          <Square className="size-4" />
        </button>
      </div>
      <div className="mx-2.5 mb-2 h-[3px] overflow-hidden rounded-sm bg-border-soft">
        <i ref={progressRef} className="block h-full w-0 rounded-sm bg-error" />
      </div>
    </div>
  );
}
