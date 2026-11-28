import { useEffect, useRef } from "react";

/**
 * The browser's own video player, for every file the browser decodes itself: the File Explorer's
 * preview tab and a report card's file viewer (`/card-file/<id>`).
 *
 * The native controls are the point. They replaced a hand-drawn control bar with two faults found
 * on a phone. Its picture area toggled play on every tap (`click` with `detail === 1`), and iOS
 * reports every tap as `detail` 1, so a double tap (meant for full screen) played and paused at
 * once. Its full-screen button called `requestFullscreen` on a `<div>`, which iPhone Safari does
 * not have. The native player has none of this: one tap shows the controls, a seek is one Range
 * request, and full screen works on every browser, iPhone included.
 *
 * `preload="metadata"` fetches only the start of the file (length, first frame) until play is
 * pressed. The element is keyed by `src`, so a new file gets a fresh element rather than one that
 * keeps the old position.
 */
export function NativeVideo({ src, autoPlay = false, onError, label, startAt, onProgress }: {
  src: string;
  autoPlay?: boolean;
  /** The browser cannot decode it (HEVC in a .mov, say); the caller may try another way. */
  onError?: () => void;
  label?: string;
  /** Seconds to start at: where the other copy was when the viewer switched Original / Smooth. */
  startAt?: number;
  /** Where playback is and whether it plays, so a switch of copy can carry on from there. */
  onProgress?: (time: number, playing: boolean) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  // Leaving the player stops its download: a detached <video> keeps fetching until it is
  // garbage-collected, and over a slow link that steals the bandwidth the next page needs.
  useEffect(() => {
    const v = ref.current;
    return () => {
      if (v && !v.isConnected) {
        v.pause();
        v.removeAttribute("src");
        v.load();
      }
    };
  }, [src]);

  return (
    <div className="flex h-full w-full items-center justify-center bg-black" data-testid="native-video">
      <video
        key={src}
        ref={ref}
        src={src}
        controls
        playsInline
        preload="metadata"
        autoPlay={autoPlay}
        aria-label={label}
        className="max-h-full max-w-full"
        onError={onError}
        onLoadedMetadata={(e) => { if (startAt && startAt > 0) e.currentTarget.currentTime = startAt; }}
        onTimeUpdate={(e) => onProgress?.(e.currentTarget.currentTime, !e.currentTarget.paused)}
        onPause={(e) => onProgress?.(e.currentTarget.currentTime, false)}
        onPlay={(e) => onProgress?.(e.currentTarget.currentTime, true)}
      />
    </div>
  );
}
