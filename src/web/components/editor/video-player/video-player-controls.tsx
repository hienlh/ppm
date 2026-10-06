import { Maximize, Minimize, Pause, Play, Volume1, Volume2, VolumeX } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { VideoSettingsMenu } from "./video-settings-menu";
import type { VideoTransform } from "./video-transform";

interface Props {
  playing: boolean;
  position: number;
  duration: number | null;
  volume: number;
  muted: boolean;
  speed: number;
  transform: VideoTransform;
  fullscreen: boolean;
  onTogglePlay: () => void;
  /** Live value while the thumb is dragged. */
  onScrub: (t: number) => void;
  /** Final value when the drag ends. */
  onSeek: (t: number) => void;
  onVolume: (v: number) => void;
  onToggleMute: () => void;
  onSpeed: (rate: number) => void;
  onRotate: (direction: 1 | -1) => void;
  onFlipH: () => void;
  onFlipV: () => void;
  onResetTransform: () => void;
  onToggleFullscreen: () => void;
}

const SEEK_STEPS_PER_SECOND = 10;

/**
 * The seek slider's value, already on its step grid. A range input snaps its value to
 * `step`, while React remembers the unsnapped number it rendered — so the `change` event
 * the browser fires when a drag ends looked like a new value to React, and `onChange`
 * reported the position from before the drag. That froze the bar and the clock there while
 * the video played on from where the thumb was dropped.
 */
export function seekBarValue(position: number, duration: number): number {
  return Math.floor(Math.min(position, duration) * SEEK_STEPS_PER_SECOND) / SEEK_STEPS_PER_SECOND;
}

/** Bottom bar: 44px targets, primary actions in thumb reach on phones. */
export function VideoPlayerControls(p: Props) {
  const VolumeIcon = p.muted || p.volume === 0 ? VolumeX : p.volume < 0.5 ? Volume1 : Volume2;
  const commit = (e: React.SyntheticEvent<HTMLInputElement>) => p.onSeek(Number((e.target as HTMLInputElement).value));

  return (
    <div className="flex items-center gap-1 px-2 py-1 bg-surface border-t border-border">
      <Button variant="ghost" size="icon" className="size-11 shrink-0" onClick={p.onTogglePlay} aria-label={p.playing ? "Pause" : "Play"}>
        {p.playing ? <Pause className="size-5" /> : <Play className="size-5" />}
      </Button>

      <span className="text-xs tabular-nums text-text-secondary shrink-0 min-w-[4.5rem] text-center">
        {formatClock(p.position)}{p.duration ? ` / ${formatClock(p.duration)}` : ""}
      </span>

      {p.duration ? (
        <input
          type="range"
          min={0}
          max={p.duration}
          step={1 / SEEK_STEPS_PER_SECOND}
          value={seekBarValue(p.position, p.duration)}
          aria-label="Seek"
          className="flex-1 h-11 accent-primary cursor-pointer min-w-0"
          onChange={(e) => p.onScrub(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onTouchEnd={commit}
          // A drag the browser takes over for scrolling ends here, with no pointerup.
          onPointerCancel={commit}
          onTouchCancel={commit}
        />
      ) : <div className="flex-1" />}

      {/* Volume: icon toggles mute, slider sets level. Slider hidden on phones (hardware keys). */}
      <div className="flex items-center shrink-0">
        <Button variant="ghost" size="icon" className="size-11" onClick={p.onToggleMute} aria-label={p.muted ? "Unmute" : "Mute"}>
          <VolumeIcon className="size-5" />
        </Button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={p.muted ? 0 : p.volume}
          aria-label="Volume"
          className="hidden sm:block w-20 h-11 accent-primary cursor-pointer"
          onChange={(e) => p.onVolume(Number(e.target.value))}
        />
      </div>

      <VideoSettingsMenu
        speed={p.speed}
        onSpeed={p.onSpeed}
        transform={p.transform}
        onRotate={p.onRotate}
        onFlipH={p.onFlipH}
        onFlipV={p.onFlipV}
        onResetTransform={p.onResetTransform}
      />

      <Button variant="ghost" size="icon" className="size-11 shrink-0" onClick={p.onToggleFullscreen} aria-label={p.fullscreen ? "Exit fullscreen" : "Fullscreen"}>
        {p.fullscreen ? <Minimize className="size-5" /> : <Maximize className="size-5" />}
      </Button>
    </div>
  );
}

/** 65 → "1:05", 3725 → "1:02:05". */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(r).padStart(2, "0")}`;
}
