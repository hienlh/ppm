/**
 * Per-platform ffmpeg *input* side of the capture pipeline. The shared low-latency flags and
 * the encoder live in `remote-desktop-capture.ts` / `remote-desktop-encoder-args.ts`; this file
 * only answers "which grabber, pointed at what, filtered how".
 *
 * macOS (`avfoundation`) lessons, measured on macOS 26 / ffmpeg 7.1.1:
 * - Devices are addressed by NAME, never by index. avfoundation lists cameras before screens
 *   and the list changes at runtime (an iPhone Continuity Camera joining/leaving moved
 *   "Capture screen 0" from index 5 to 3 and back within a minute) — an index captured at
 *   detect time pointed at the phone camera by spawn time. Addressing by name also removes
 *   the `-list_devices` pre-flight, which cost 0.4–1 s per session start.
 * - `-framerate 30` is ignored: the screen input delivers at display refresh (120–165 fps on
 *   ProMotion) with a pts that never advances. `-use_wallclock_as_timestamps 1` restores pts
 *   and an `fps=30` filter drops back to the target rate (measured 29 fps steady, ~1.3 s to
 *   first frame). Without it the encoder spends 6 Mbit/s and a 30-frame GOP on 160 fps.
 * - `-pixel_format nv12` on the input side: the device has no yuv420p, and letting the output
 *   `-pix_fmt` request leak into the device negotiation logs a warning per open.
 * - A missing Screen Recording grant does NOT fail the spawn — macOS hands the process black
 *   frames instead; that is surfaced client-side by the "real frame" check, not here.
 */
import { CAPTURE_FRAMERATE } from "./remote-desktop-encoder-args.ts";

export type CaptureInput =
  | { kind: "gdigrab" }
  | { kind: "avfoundation"; screen: string };

/** avfoundation's name for the N-th display in `CGGetActiveDisplayList` order (0 = main). */
export function avfoundationScreenName(captureIndex: number): string {
  return `Capture screen ${captureIndex}`;
}

/** ffmpeg args from `-f <grabber>` through `-i <source>` for the given input. */
export function captureInputArgs(input: CaptureInput): string[] {
  switch (input.kind) {
    case "gdigrab":
      return ["-f", "gdigrab", "-framerate", String(CAPTURE_FRAMERATE), "-i", "desktop"];
    case "avfoundation":
      // `-capture_cursor 1` draws the pointer into the frame (gdigrab does so by default).
      return ["-use_wallclock_as_timestamps", "1",
        "-f", "avfoundation", "-capture_cursor", "1", "-pixel_format", "nv12",
        "-framerate", String(CAPTURE_FRAMERATE), "-i", input.screen];
  }
}

/** `-vf` chain for the given input; the scale step is shared, avfoundation adds the rate cap. */
export function captureVideoFilter(input: CaptureInput): string {
  const scale = "scale=-2:720";
  return input.kind === "avfoundation" ? `fps=${CAPTURE_FRAMERATE},${scale}` : scale;
}

/** Pick the capture input for this host; null on platforms without a grabber. Whether the
 *  grabber actually works (ffmpeg built without it, no display) surfaces through ffmpeg's
 *  own exit + stderr tail in `startCapture`, the same way gdigrab failures do.
 *  `captureIndex` selects the display on backends that capture one at a time (avfoundation);
 *  gdigrab always grabs the whole virtual desktop. */
export function captureInputForPlatform(platform: NodeJS.Platform = process.platform, captureIndex = 0): CaptureInput | null {
  switch (platform) {
    case "win32": return { kind: "gdigrab" };
    case "darwin": return { kind: "avfoundation", screen: avfoundationScreenName(captureIndex) };
    default: return null;
  }
}
