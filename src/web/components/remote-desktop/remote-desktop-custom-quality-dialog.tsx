/**
 * RustDesk's "Custom image quality" dialog: a bitrate-percentage slider, an fps slider, a
 * "More" checkbox that raises the bitrate ceiling from 100% to 2000%, and Close.
 *
 * Both sliders commit on a debounce, not per tick: each commit respawns the host's ffmpeg
 * (`-b:v`/`-r` are fixed at spawn), so a dragged slider would otherwise restart the capture
 * dozens of times and the picture would strobe. RustDesk gets away with per-tick updates
 * because its encoder is retunable in place; ours is not, and that difference is the reason
 * for the delay rather than an arbitrary choice.
 *
 * Shown as a bottom sheet below `md` per `docs/design-guidelines.md`.
 */
import { useEffect, useRef, useState } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  CUSTOM_FPS_MAX, CUSTOM_FPS_MIN, CUSTOM_QUALITY_MAX_MORE_PERCENT, CUSTOM_QUALITY_MAX_PERCENT,
  CUSTOM_QUALITY_MIN_PERCENT, clampCustomFps, clampCustomQualityPercent, customBitrateKbps,
} from "../../../shared/remote-desktop-custom-quality";

/** Long enough that a drag is one respawn, short enough to feel like a live control. */
const COMMIT_DEBOUNCE_MS = 400;

export interface RemoteDesktopCustomQualityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  percent: number;
  fps: number;
  more: boolean;
  onSetMore: (more: boolean) => void;
  /** Commit both values; also selects the custom rung. */
  onCommit: (percent: number, fps: number) => void;
  /** The capture's own size, so the dialog can say what the percentage really costs. */
  frameSize: { width: number; height: number };
}

export function RemoteDesktopCustomQualityDialog({
  open, onOpenChange, percent, fps, more, onSetMore, onCommit, frameSize,
}: RemoteDesktopCustomQualityDialogProps) {
  const [localPercent, setLocalPercent] = useState(percent);
  const [localFps, setLocalFps] = useState(fps);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Adopt the stored values whenever the dialog is opened, so it never shows a stale drag.
  useEffect(() => { if (open) { setLocalPercent(percent); setLocalFps(fps); } }, [open, percent, fps]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const max = more ? CUSTOM_QUALITY_MAX_MORE_PERCENT : CUSTOM_QUALITY_MAX_PERCENT;

  const commitLater = (nextPercent: number, nextFps: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onCommit(nextPercent, nextFps), COMMIT_DEBOUNCE_MS);
  };
  const changePercent = (raw: number) => {
    const next = clampCustomQualityPercent(raw, more);
    setLocalPercent(next);
    commitLater(next, localFps);
  };
  const changeFps = (raw: number) => {
    const next = clampCustomFps(raw);
    setLocalFps(next);
    commitLater(localPercent, next);
  };
  const toggleMore = (next: boolean) => {
    onSetMore(next);
    // Turning it off strands a percent above the new ceiling; commit the clamped value so the
    // host is never left encoding at a rate the dialog no longer shows.
    const clamped = clampCustomQualityPercent(localPercent, next);
    if (clamped !== localPercent) { setLocalPercent(clamped); commitLater(clamped, localFps); }
  };

  const kbps = customBitrateKbps(localPercent, frameSize.width, frameSize.height);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="remote-desktop-custom-quality-dialog">
        <DialogHeader>
          <DialogTitle>Custom image quality</DialogTitle>
          <DialogDescription>
            {/* RustDesk shows the bare percentage. The real figure is worth showing because the
                percentage is not a ratio — 50% is the resolution's *base* bitrate, not half of
                anything — so the number alone reads as "half quality" and is not. */}
            {frameSize.width > 0
              ? `${localPercent}% of the base rate for ${frameSize.width}×${frameSize.height} — about ${(kbps / 1000).toFixed(1)} Mbit/s`
              : "Waiting for the first frame"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={CUSTOM_QUALITY_MIN_PERCENT}
              max={max}
              step={1}
              value={Math.min(localPercent, max)}
              onChange={(e) => changePercent(Number(e.target.value))}
              aria-label="Bitrate"
              data-testid="remote-desktop-custom-bitrate"
              className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded bg-accent accent-primary"
            />
            <span className="w-14 text-right text-xs tabular-nums">{localPercent}%</span>
            <span className="w-14 text-xs text-muted-foreground">Bitrate</span>
            <label className="flex shrink-0 items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={more}
                onChange={(e) => toggleMore(e.target.checked)}
                data-testid="remote-desktop-custom-more"
                className="size-3.5 accent-primary"
              />
              More
            </label>
          </div>

          <div className="flex items-center gap-3">
            <input
              type="range"
              min={CUSTOM_FPS_MIN}
              max={CUSTOM_FPS_MAX}
              step={1}
              value={localFps}
              onChange={(e) => changeFps(Number(e.target.value))}
              aria-label="FPS"
              data-testid="remote-desktop-custom-fps"
              className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded bg-accent accent-primary"
            />
            <span className="w-14 text-right text-xs tabular-nums">{localFps}</span>
            <span className="w-14 text-xs text-muted-foreground">FPS</span>
            {/* Keeps the two rows' sliders the same length as the row above, which carries an
                extra checkbox. */}
            <span className="w-[4.25rem] shrink-0" aria-hidden />
          </div>
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
