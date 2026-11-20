/**
 * A voice message's player: a round play/pause button, a row of bars that fill as it plays (and
 * seek where they are tapped), and the time. Used by the composer's voice chip on the local
 * recording and by the sent bubble on the uploaded copy.
 *
 * The bubble's copy sits behind auth that an `<audio src>` cannot send, so the source can be a
 * loader that fetches it with the token: it runs on the first play only, not for every voice
 * message a long chat renders.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Pause, Play } from "@/lib/icons";
import { formatVoiceDuration } from "../../../shared/voice-message";
import { cn } from "@/lib/utils";

interface VoiceAudioPlayerProps {
  /** A playable URL (the local recording), or a loader resolving to one. */
  src: string | (() => Promise<string>);
  durationSec: number;
  /** How many bars to draw; the chip is short, the bubble wide. */
  bars?: number;
  size?: "sm" | "md";
  /** Seeds the bar heights, so one message always draws the same shape. */
  seed?: string;
  className?: string;
}

/** Bar heights between 0.3 and 1, from a seed: a stand-in waveform that is stable per message. */
export function voiceBarHeights(count: number, seed: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    out.push(0.3 + (h % 1000) / 1000 * 0.7);
  }
  return out;
}

export function VoiceAudioPlayer({ src, durationSec, bars = 24, size = "md", seed = "voice", className }: VoiceAudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [url, setUrl] = useState<string | null>(typeof src === "string" ? src : null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [position, setPosition] = useState(0);
  const heights = useMemo(() => voiceBarHeights(bars, seed), [bars, seed]);

  useEffect(() => { if (typeof src === "string") setUrl(src); }, [src]);

  const total = durationSec > 0 ? durationSec : 1;
  const progress = Math.min(1, position / total);

  async function ensureUrl(): Promise<string | null> {
    if (url) return url;
    if (typeof src === "string") return src;
    setLoading(true);
    try {
      const loaded = await src();
      setUrl(loaded);
      return loaded;
    } catch {
      setFailed(true);
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) { audio.pause(); return; }
    const playable = await ensureUrl();
    if (!playable) return;
    if (audio.src !== playable) audio.src = playable;
    try {
      await audio.play();
    } catch {
      setFailed(true);
    }
  }

  async function seek(fraction: number) {
    const audio = audioRef.current;
    const playable = audio ? await ensureUrl() : null;
    if (!audio || !playable) return;
    if (!audio.src) audio.src = playable;
    const target = Math.max(0, Math.min(1, fraction)) * total;
    audio.currentTime = target;
    setPosition(target);
  }

  const sm = size === "sm";
  const label = failed ? "Recording unavailable" : playing ? "Pause voice message" : "Play voice message";
  return (
    <div className={cn("flex min-w-0 items-center", sm ? "gap-1.5" : "gap-2.5", className)}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); void toggle(); }}
        disabled={failed}
        aria-label={label}
        title={label}
        className={cn(
          "relative grid shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-transform motion-safe:active:scale-[0.95] disabled:opacity-40",
          "before:absolute before:content-['']",
          sm ? "size-6 before:-inset-2.5" : "size-8 before:-inset-1.5",
        )}
      >
        {loading ? <Loader2 className={cn("animate-spin", sm ? "size-3" : "size-3.5")} />
          : playing ? <Pause className={sm ? "size-3" : "size-3.5"} />
          : <Play className={sm ? "size-3" : "size-3.5"} />}
      </button>
      <div
        role="slider"
        aria-label="Position"
        aria-valuemin={0}
        aria-valuemax={Math.round(total)}
        aria-valuenow={Math.round(position)}
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          void seek((e.clientX - rect.left) / Math.max(1, rect.width));
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") { e.preventDefault(); void seek((position + 5) / total); }
          if (e.key === "ArrowLeft") { e.preventDefault(); void seek((position - 5) / total); }
        }}
        className={cn("flex min-w-0 flex-1 cursor-pointer items-center gap-[2px] rounded", sm ? "h-[18px]" : "h-[26px]")}
      >
        {heights.map((height, i) => (
          <i
            key={i}
            className={cn("block w-[3px] shrink-0 rounded-sm", i / heights.length < progress ? "bg-primary" : "bg-text-3/50")}
            style={{ height: `${Math.round(height * 100)}%` }}
          />
        ))}
      </div>
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-2">
        {playing || position > 0 ? formatVoiceDuration(position) : formatVoiceDuration(durationSec)}
      </span>
      <audio
        ref={audioRef}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setPosition(0); }}
        onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
        onError={() => { if (audioRef.current?.src) setFailed(true); }}
        className="hidden"
      />
    </div>
  );
}
