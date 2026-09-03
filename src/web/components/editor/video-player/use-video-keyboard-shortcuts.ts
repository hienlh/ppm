import { useCallback, type KeyboardEvent } from "react";

/** What the player exposes for keyboard control; the hook stays free of player state. */
export interface VideoPlayerActions {
  togglePlay: () => void;
  /** Positive = forward, seconds. */
  seekBy: (deltaSeconds: number) => void;
  toggleFullscreen: () => void;
  toggleMute: () => void;
  /** Positive = louder, in 0..1 units. */
  volumeBy: (delta: number) => void;
  /** +1 = next speed step, -1 = previous. */
  speedStep: (direction: 1 | -1) => void;
  /** +1 = clockwise, -1 = counter-clockwise. */
  rotate: (direction: 1 | -1) => void;
}

/** YouTube-style bindings, documented in the settings menu of the player. */
export const VIDEO_SHORTCUTS: ReadonlyArray<[keys: string, action: string]> = [
  ["Space / K", "Play / pause"],
  ["← / →", "Seek 5s"],
  ["J / L or Shift+← / →", "Seek 10s"],
  ["↑ / ↓", "Volume"],
  ["M", "Mute"],
  ["F", "Fullscreen"],
  ["< / >", "Speed"],
  ["R / Shift+R", "Rotate"],
];

/**
 * Returns an `onKeyDown` handler for the player root (which must be focusable).
 * Keys typed into the range sliders are left alone so arrows still nudge the slider.
 */
export function useVideoKeyboardShortcuts(actions: VideoPlayerActions) {
  return useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      let handled = true;
      switch (e.key) {
        case " ": case "k": case "K": actions.togglePlay(); break;
        case "ArrowLeft": actions.seekBy(e.shiftKey ? -10 : -5); break;
        case "ArrowRight": actions.seekBy(e.shiftKey ? 10 : 5); break;
        case "j": case "J": actions.seekBy(-10); break;
        case "l": case "L": actions.seekBy(10); break;
        case "ArrowUp": actions.volumeBy(0.1); break;
        case "ArrowDown": actions.volumeBy(-0.1); break;
        case "m": case "M": actions.toggleMute(); break;
        case "f": case "F": actions.toggleFullscreen(); break;
        case "<": case ",": actions.speedStep(-1); break;
        case ">": case ".": actions.speedStep(1); break;
        case "r": actions.rotate(1); break;
        case "R": actions.rotate(-1); break;
        default: handled = false;
      }
      if (handled) e.preventDefault();
    },
    [actions],
  );
}
