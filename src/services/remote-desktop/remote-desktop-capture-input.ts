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
 *
 * X11 (`x11grab`) notes:
 * - The grabber honours `-framerate` (unlike avfoundation), so it keeps gdigrab's plain filter.
 * - X11 gives every monitor one root-window coordinate space, so capturing a single monitor is
 *   a crop: `-video_size WxH -i :0.0+X,Y`. Without the offsets you get the union of all
 *   monitors, which on a two-screen host is a letterboxed image of both.
 * - `-draw_mouse` defaults to 1, but it is passed explicitly: it is the one thing that makes a
 *   remote session usable and it should not silently change with an ffmpeg default. It is also
 *   the only cursor control there is — the pointer is burned into the frames at *capture* time,
 *   so turning it off is a respawn, never a client-side decision.
 * - The spawn needs `DISPLAY`/`XAUTHORITY` in its env — see `remote-desktop-linux-session.ts`
 *   for why the PPM process usually does not have them itself.
 */
import { DEFAULT_FPS, type QualityPreset } from "./remote-desktop-quality.ts";
import { VAAPI_UPLOAD_FILTER } from "../media-transcode/ffmpeg-capabilities.ts";
import { detectLinuxSession, type LinuxSession } from "./remote-desktop-linux-session.ts";

/** The region to grab, in the OS's global coordinate space. null = the backend's whole surface. */
export interface CaptureRect { x: number; y: number; width: number; height: number }

export type CaptureInput =
  | { kind: "gdigrab" }
  | { kind: "avfoundation"; screen: string }
  | { kind: "x11grab"; display: string; rect: CaptureRect | null };

/** avfoundation's name for the N-th display in `CGGetActiveDisplayList` order (0 = main). */
export function avfoundationScreenName(captureIndex: number): string {
  return `Capture screen ${captureIndex}`;
}

/** x11grab's source string: `:<display>.<screen>+<x>,<y>`. The screen number is only appended
 *  when the display string does not already carry one — `DISPLAY` is normally `:0`, but a
 *  `:0.0` in the environment would otherwise become `:0.0.0` and fail to parse. */
export function x11GrabSource(display: string, rect: CaptureRect | null): string {
  const withScreen = display.includes(".") ? display : `${display}.0`;
  return rect ? `${withScreen}+${rect.x},${rect.y}` : withScreen;
}

/** ffmpeg args from `-f <grabber>` through `-i <source>` for the given input.
 *
 *  `drawMouse` is the host pointer. All three grabbers draw it by default and each spells the
 *  flag differently — gdigrab and x11grab take `-draw_mouse`, avfoundation `-capture_cursor` —
 *  so the one place that knows which grabber is in use is the one that has to translate it. */
export function captureInputArgs(
  input: CaptureInput,
  preset: QualityPreset = { fps: DEFAULT_FPS, bitrate: "1M" },
  drawMouse = true,
): string[] {
  const fps = String(preset.fps);
  const mouse = drawMouse ? "1" : "0";
  switch (input.kind) {
    case "gdigrab":
      return ["-f", "gdigrab", "-draw_mouse", mouse, "-framerate", fps, "-i", "desktop"];
    case "avfoundation":
      return ["-use_wallclock_as_timestamps", "1",
        "-f", "avfoundation", "-capture_cursor", mouse, "-pixel_format", "nv12",
        "-framerate", fps, "-i", input.screen];
    case "x11grab":
      return ["-f", "x11grab", "-draw_mouse", mouse, "-framerate", fps,
        ...(input.rect ? ["-video_size", `${input.rect.width}x${input.rect.height}`] : []),
        "-i", x11GrabSource(input.display, input.rect)];
  }
}

/** `-vf` chain for the given input; avfoundation adds the rate cap and VAAPI appends the upload
 *  to GPU memory that its encoder requires. One `-vf` only: a second occurrence would silently
 *  replace the first rather than combining.
 *
 *  There is **no scale step**. A quality rung sets a bitrate ratio and nothing else — RustDesk's
 *  image quality never touches the resolution, and measured on a 3440x1440 host the downscale
 *  this used to do bought almost nothing: 720p used 1.17 Mbit/s against 1.26 Mbit/s for native
 *  at the same cap, because a desktop is mostly static and H.264 spends bits on *change* rather
 *  than on area. It cost 4.8x the pixels for 7% of the bandwidth. Dropping the filter also
 *  removes the upscale hazard it existed to guard against: with no scaling at all, a rung cannot
 *  ask for more pixels than the host has.
 *
 *  Returns an empty string when there is nothing to filter, which the caller must treat as
 *  "omit `-vf` entirely" — ffmpeg rejects an empty filtergraph argument. */
export function captureVideoFilter(
  input: CaptureInput,
  encoder = "libx264",
  preset: QualityPreset = { fps: DEFAULT_FPS, bitrate: "1M" },
): string {
  const parts: string[] = [];
  // avfoundation ignores `-framerate` and delivers at display refresh with a stuck pts, so the
  // cadence has to be imposed here; the other grabbers take it at the input.
  if (input.kind === "avfoundation") parts.push(`fps=${preset.fps}`);
  if (encoder === "h264_vaapi") parts.push(VAAPI_UPLOAD_FILTER);
  return parts.join(",");
}

/** Pick the capture input for this host; null on platforms without a grabber. Whether the
 *  grabber actually works (ffmpeg built without it, no display) surfaces through ffmpeg's
 *  own exit + stderr tail in `startCapture`, the same way gdigrab failures do.
 *  `captureIndex` selects the display on backends that capture one at a time (avfoundation);
 *  gdigrab always grabs the whole virtual desktop, x11grab crops by `rect`.
 *
 *  `opts.session` is passed explicitly by tests so this stays a pure function of its
 *  arguments: it otherwise probes the host, and "is there an X server" is exactly the thing a
 *  headless CI runner answers differently from a developer's desktop. */
export function captureInputForPlatform(
  platform: NodeJS.Platform = process.platform,
  captureIndex = 0,
  opts: { session?: LinuxSession | null; rect?: CaptureRect | null } = {},
): CaptureInput | null {
  switch (platform) {
    case "win32": return { kind: "gdigrab" };
    case "darwin": return { kind: "avfoundation", screen: avfoundationScreenName(captureIndex) };
    case "linux": {
      const session = "session" in opts ? opts.session : detectLinuxSession();
      if (session?.kind !== "x11") return null;
      return { kind: "x11grab", display: session.display, rect: opts.rect ?? null };
    }
    default: return null;
  }
}
