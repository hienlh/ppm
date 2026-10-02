/**
 * The device's own buttons, plus the session controls that belong beside them.
 *
 * One component for both form factors rather than two: the *contents* are identical — an
 * emulator has the same three navigation buttons whatever is looking at it — and only the
 * placement differs. Below `md` it sits in the thumb zone at the bottom of the viewer (design
 * guidelines §9: navigation bars go to the bottom, not the top); above it, the same row sits in
 * the toolbar. Two copies would drift.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft, Circle, Square, Keyboard, RotateCw, Power, Volume2, Volume1, MoreHorizontal,
} from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { AndroidClientMessage, AndroidQuality } from "../../../shared/android-protocol";

export interface AndroidControlsProps {
  send: (message: AndroidClientMessage) => void;
  /** Without the lease every button here is a no-op on the server, so they are disabled. */
  controller: boolean;
  rotation: 0 | 90 | 180 | 270;
  quality: AndroidQuality;
  onQualityChange: (quality: AndroidQuality) => void;
  onKeyboard: () => void;
  layout: "bar" | "toolbar";
}

const QUALITY_LABELS: Record<AndroidQuality, string> = {
  low: "Low", balanced: "Balanced", high: "High",
};

export function AndroidControls(props: AndroidControlsProps) {
  const { send, controller, rotation, quality, onQualityChange, onKeyboard, layout } = props;
  const [extrasOpen, setExtrasOpen] = useState(false);
  const bar = layout === "bar";

  // 44x44 minimum on touch (design guidelines §3); the toolbar variant is desktop-only and may
  // be tighter, but never below 36px.
  const buttonClass = bar ? "size-11" : "size-9";

  const key = (k: "home" | "back" | "recent" | "power" | "volume-up" | "volume-down") =>
    () => send({ type: "hardware", key: k });

  return (
    <div className={cn("flex items-center gap-2", containerClass(bar))}>
      <Button variant="ghost" size="icon" className={buttonClass} disabled={!controller}
        onClick={key("back")} title="Back" aria-label="Back">
        <ArrowLeft />
      </Button>
      <Button variant="ghost" size="icon" className={buttonClass} disabled={!controller}
        onClick={key("home")} title="Home" aria-label="Home">
        <Circle />
      </Button>
      <Button variant="ghost" size="icon" className={buttonClass} disabled={!controller}
        onClick={key("recent")} title="Recent apps" aria-label="Recent apps">
        <Square />
      </Button>

      <span className="mx-1 h-6 w-px shrink-0 bg-border" aria-hidden />

      <Button variant="ghost" size="icon" className={buttonClass} disabled={!controller}
        onClick={onKeyboard} title="Keyboard" aria-label="Keyboard">
        <Keyboard />
      </Button>
      <Button variant="ghost" size="icon" className={buttonClass} disabled={!controller}
        onClick={() => send({ type: "rotate", rotation: nextRotation(rotation) })}
        title={`Rotate (now ${rotation}°)`} aria-label="Rotate">
        <RotateCw />
      </Button>

      {/* The rarely-used keys stay behind one more tap: a mis-hit Power on a phone is a guest
          that goes to sleep mid-demo, and §9 puts destructive things out of easy reach. */}
      <Button variant="ghost" size="icon" className={buttonClass} disabled={!controller}
        onClick={() => setExtrasOpen((v) => !v)} title="More keys" aria-label="More keys"
        aria-expanded={extrasOpen}>
        <MoreHorizontal />
      </Button>
      {extrasOpen && (
        <>
          <Button variant="ghost" size="icon" className={buttonClass} disabled={!controller}
            onClick={key("volume-up")} title="Volume up" aria-label="Volume up">
            <Volume2 />
          </Button>
          <Button variant="ghost" size="icon" className={buttonClass} disabled={!controller}
            onClick={key("volume-down")} title="Volume down" aria-label="Volume down">
            <Volume1 />
          </Button>
          <Button variant="ghost" size="icon" className={buttonClass} disabled={!controller}
            onClick={key("power")} title="Power" aria-label="Power">
            <Power />
          </Button>
        </>
      )}

      <span className="flex-1" />

      {/* A native select, per design guidelines §8 — a phone gets its own picker for free. */}
      <label className="sr-only" htmlFor="android-quality">Quality</label>
      <select
        id="android-quality"
        className={cn(
          "rounded-md border bg-background px-2 text-sm",
          bar ? "h-11" : "h-9",
        )}
        value={quality}
        disabled={!controller}
        onChange={(e) => onQualityChange(e.target.value as AndroidQuality)}
      >
        {(Object.keys(QUALITY_LABELS) as AndroidQuality[]).map((q) => (
          <option key={q} value={q}>{QUALITY_LABELS[q]}</option>
        ))}
      </select>
    </div>
  );
}

function containerClass(bar: boolean): string {
  return bar
    ? "w-full justify-center border-t bg-background/95 px-3 py-2 backdrop-blur"
    : "px-2 py-1";
}

/** 0 -> 90 -> 180 -> 270 -> 0. One button rather than four: a phone-shaped toolbar has no room
 *  for a rotation picker, and every orientation is two taps away at worst. */
export function nextRotation(current: 0 | 90 | 180 | 270): 0 | 90 | 180 | 270 {
  return (((current + 90) % 360) as 0 | 90 | 180 | 270);
}
