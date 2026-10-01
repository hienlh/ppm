/**
 * How large the capture should be, given the size the viewer can actually draw it at.
 *
 * Two separate problems meet here, and only one of them is about bandwidth.
 *
 * **The hard one is the decoder.** A browser's H.264 decoder has a maximum frame width, and on
 * this machine it was measured the hard way: a Mac with a HiDPI ultrawide reports 2580x1080
 * *points* and avfoundation captures the panel's **5160x2160 pixels**. Chrome accepted the
 * codec, configured the decoder, swallowed six keyframes and then answered `"Decoding error."`
 * on every one after — a black canvas with nothing in the console, forever, because the client
 * reconfigures and retries. `ffmpeg` decodes the identical bytes without a complaint, so the
 * stream is valid and the limit is the decoder's. `VideoDecoder.isConfigSupported()` is no
 * defence: PPM asks it about a codec string with no dimensions, so it answers `true` for a frame
 * no decoder on the machine can take. `MAX_DECODABLE_WIDTH` is therefore a **bound, not a
 * preference** — it applies however big the viewer's window is.
 *
 * **The soft one is waste.** Streaming 5160x2160 into a canvas 1200 CSS pixels wide spends
 * encode time, bandwidth and decode time on detail that is then thrown away by the browser's
 * own downscale. So the capture is also bounded by what the viewer can show.
 *
 * Note what this is *not*. The quality ladder deliberately carries no resolution (see the
 * RustDesk note in CLAUDE.md: downscaling 1440p to 720p bought 7% of the bitrate for 4.8x fewer
 * pixels, because H.264 spends bits on change rather than area). That finding stands and this
 * does not contradict it: a rung must not trade resolution for bitrate, while a frame the
 * decoder cannot decode, or pixels the viewport cannot show, are not a trade at all.
 *
 * Two rules keep this from costing anything in the ordinary case.
 *
 * It **never upscales**. The filter bounds by `min(iw, …)`, so a viewer on a 4K screen watching
 * a 1080p host still gets 1080p rather than a blurred 4K re-render.
 *
 * And when nothing needs bounding it emits **no filter at all**, so `buildCaptureArgs` is
 * byte-identical to before for every host that was already working — a new scale step on every
 * session would put swscale in the path of the Linux and Windows grabbers that never needed it.
 */

/**
 * The widest frame a browser's H.264 decoder is assumed to take.
 *
 * 4096 is the common hardware limit (Chrome/VideoToolbox, Chrome/VAAPI, most mobile SoCs), and
 * the measurement above is one host failing at 5160 and working at 3840. It is deliberately a
 * fixed number rather than something probed: the client cannot ask "how wide can you go" —
 * `isConfigSupported` lies, as recorded above — so the only honest options are a conservative
 * constant or a black picture, and this is a bound that costs nothing until a host exceeds it.
 */
export const MAX_DECODABLE_WIDTH = 4096;
/** The same bound on the other axis, for a portrait display. */
export const MAX_DECODABLE_HEIGHT = 4096;

/**
 * Viewport sizes are quantised before they reach ffmpeg, because **every change respawns the
 * capture** (~400 ms with no picture, see `restartCapture`) and a window drag emits a resize
 * event per frame. Rounding *up* to the next step also means the stream is never softer than the
 * space it is drawn in.
 *
 * 320 px steps: fine enough that a half-screen window is not served a full-screen stream, coarse
 * enough that nudging a window edge changes nothing.
 */
export const VIEWPORT_STEP = 320;
/** Below this the picture stops being usable at all, whatever the window says — a collapsed
 *  pane briefly reports a few pixels wide while React settles. */
export const MIN_VIEWPORT_WIDTH = 640;

/** What the client says it can draw, in **device** pixels (CSS pixels x devicePixelRatio). */
export interface ViewportSize {
  width: number;
  height: number;
}

/** Reject anything that is not a usable pair of pixel counts. The value arrives over the wire,
 *  so `NaN`, a string, a negative or an absurd number are all expected inputs rather than bugs. */
export function parseViewportSize(value: unknown): ViewportSize | null {
  if (!value || typeof value !== "object") return null;
  const { width, height } = value as Record<string, unknown>;
  if (typeof width !== "number" || typeof height !== "number") return null;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < 1 || height < 1) return null;
  // Nothing on earth draws this; a value above it is a bug or a probe, and clamping is kinder
  // than refusing, since the decoder bound below would cut it to size anyway.
  if (width > 32_768 || height > 32_768) return null;
  return { width: Math.round(width), height: Math.round(height) };
}

/** Round up to the next `VIEWPORT_STEP`, with a floor. Pure, and the only place the quantisation
 *  lives, so the session can compare buckets instead of raw pixels. */
export function quantiseViewport(size: ViewportSize): ViewportSize {
  const step = (n: number, min: number) => Math.max(min, Math.ceil(n / VIEWPORT_STEP) * VIEWPORT_STEP);
  return {
    width: Math.min(step(size.width, MIN_VIEWPORT_WIDTH), MAX_DECODABLE_WIDTH),
    height: Math.min(step(size.height, Math.round(MIN_VIEWPORT_WIDTH * 9 / 16)), MAX_DECODABLE_HEIGHT),
  };
}

/**
 * The bound to apply to the capture: the viewer's quantised size when it has told us one, and
 * the decoder's maximum when it has not.
 *
 * A session with no viewport yet is the normal state for the **first** spawn — the client sends
 * its size in the `auth` message, but an older client, a WebRTC viewer or a reconnect mid-resize
 * may not — and that case must still be protected from the decoder limit, which is why this
 * never answers null.
 */
export function captureBound(viewport: ViewportSize | null): ViewportSize {
  if (!viewport) return { width: MAX_DECODABLE_WIDTH, height: MAX_DECODABLE_HEIGHT };
  return quantiseViewport(viewport);
}

/**
 * The ffmpeg `scale` fragment that applies `bound`, or `""` when the source is already within it.
 *
 * `min(iw, …)` on both axes is what makes this a bound rather than a resize: ffmpeg evaluates it
 * per stream, so a host smaller than the viewer is left alone instead of being upscaled.
 * `force_original_aspect_ratio=decrease` keeps the picture's shape, and `force_divisible_by=2`
 * is required, not tidy — H.264 in yuv420p cannot encode an odd dimension, and the rounding that
 * `decrease` performs lands on odd numbers routinely.
 *
 * `sourceWidth`/`sourceHeight` are what the host is known to be; pass nulls when that is not
 * known and the filter is emitted unconditionally, which is harmless because of the `min()`.
 */
export function captureScaleFilter(
  bound: ViewportSize,
  sourceWidth: number | null = null,
  sourceHeight: number | null = null,
): string {
  if (sourceWidth !== null && sourceHeight !== null
    && sourceWidth <= bound.width && sourceHeight <= bound.height) return "";
  return `scale=w='min(iw,${bound.width})':h='min(ih,${bound.height})'`
    + ":force_original_aspect_ratio=decrease:force_divisible_by=2";
}
