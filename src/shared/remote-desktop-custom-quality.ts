/**
 * RustDesk's "Custom image quality": a bitrate *percentage* and an fps, with the real bitrate
 * derived from the capture's own resolution. Ported rather than invented, because two parts of
 * it are counter-intuitive enough that a reasonable guess is wrong:
 *
 *  1. **The percentage is not the ratio.** `video_qos.rs:444` reads it back as
 *     `((q >> 8 & 0xFFF) * 2) / 100.0`, so the ratio is `percent × 2 / 100` — the dialog's
 *     default **50% means ratio 1.0**, i.e. exactly `base_bitrate`. Reading 50% as ratio 0.5
 *     (the obvious reading) makes every custom setting half as sharp as the user asked for,
 *     and nothing reports it: the picture is simply dimmer than the number promises.
 *  2. **`base_bitrate` is a nearest-preset lookup, not a formula.** `codec.rs:929` finds the
 *     table row whose *pixel count* is closest to the source's, then scales that row's bitrate
 *     by the pixel ratio. A plain bits-per-pixel constant does not reproduce it, because the
 *     table is deliberately non-linear (720p→1000, 1080p→2073, 4K→5000: 4× the pixels of
 *     1080p for 2.4× the bits).
 *
 * The fixed rungs use the same machinery in RustDesk (`Quality::ratio()` → Best 1.5,
 * Balanced 0.67, Low 0.5); PPM keeps its own absolute-bitrate ladder for those, so only the
 * custom path needs this.
 */

/** `RESOLUTION_PRESETS` from `libs/scrap/src/common/codec.rs`, kbps. */
const RESOLUTION_BITRATE_PRESETS: readonly (readonly [number, number, number])[] = [
  [640, 480, 400],
  [800, 600, 500],
  [1024, 768, 800],
  [1280, 720, 1000],
  [1366, 768, 1100],
  [1440, 900, 1300],
  [1600, 900, 1500],
  [1920, 1080, 2073],
  [2048, 1080, 2200],
  [2560, 1440, 3000],
  [3440, 1440, 4000],
  [3840, 2160, 5000],
  [7680, 4320, 12000],
];

/** `kMinQuality` / `kDefaultQuality` / `kMaxQuality` / `kMaxMoreQuality` from `consts.dart`. */
export const CUSTOM_QUALITY_MIN_PERCENT = 10;
export const CUSTOM_QUALITY_DEFAULT_PERCENT = 50;
export const CUSTOM_QUALITY_MAX_PERCENT = 100;
/** The "More" checkbox raises the ceiling this far — 2000% is ratio 40, which is `BR_MAX`. */
export const CUSTOM_QUALITY_MAX_MORE_PERCENT = 2000;

/** `kMinFps` / `kDefaultFps` / `kMaxFps`. */
export const CUSTOM_FPS_MIN = 5;
export const CUSTOM_FPS_DEFAULT = 30;
export const CUSTOM_FPS_MAX = 120;

/** `BR_MIN` / `BR_MAX` from `video_qos.rs`. */
const BR_MIN = 0.2;
const BR_MAX = 40.0;

/** Nearest-pixel-count preset, scaled by the pixel ratio. See note 2. */
export function baseBitrateKbps(width: number, height: number): number {
  const pixels = Math.max(1, Math.round(width) * Math.round(height));
  let best = RESOLUTION_BITRATE_PRESETS[7]!; // 1080p, the table's own fallback
  let bestDistance = Infinity;
  for (const preset of RESOLUTION_BITRATE_PRESETS) {
    const distance = Math.abs(preset[0] * preset[1] - pixels);
    if (distance < bestDistance) { bestDistance = distance; best = preset; }
  }
  const presetPixels = best[0] * best[1];
  // Floored at 1: a 0x0 capture (before the first frame) otherwise scales the smallest preset
  // down to `round(400 / 307200)` = **0**, and ffmpeg refuses a zero bitrate outright rather
  // than picking something sensible.
  return Math.max(1, Math.round(best[2] * (pixels / presetPixels)));
}

/** Percent → bitrate ratio. `percent × 2 / 100`, clamped. See note 1. */
export function customQualityRatio(percent: number): number {
  if (!Number.isFinite(percent)) return (CUSTOM_QUALITY_DEFAULT_PERCENT * 2) / 100;
  return Math.min(Math.max((percent * 2) / 100, BR_MIN), BR_MAX);
}

/** Clamp any bitrate ratio to RustDesk's own bounds. Named rungs already sit inside them; the
 *  congestion scaling in `remote-desktop-quality.ts` is what can push one out. */
export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return BR_MIN;
  return Math.min(Math.max(ratio, BR_MIN), BR_MAX);
}

/** The bitrate a ratio really encodes at, for this capture size. Every rung goes through here —
 *  a named one, a congestion-scaled one and the custom dialog's percentage alike, which is what
 *  makes "the chosen quality is a ceiling on the ratio" a statement about one number. */
export function ratioBitrateKbps(ratio: number, width: number, height: number): number {
  // Floored at 1: the table's smallest row makes `baseBitrateKbps(0, 0)` round to 0, and ffmpeg
  // refuses a zero bitrate outright.
  return Math.max(1, Math.round(baseBitrateKbps(width, height) * clampRatio(ratio)));
}

/** An ffmpeg bitrate string (`-b:v`/`-maxrate`) for a ratio. */
export function ratioBitrateArg(ratio: number, width: number, height: number): string {
  return `${ratioBitrateKbps(ratio, width, height)}k`;
}

/** The bitrate a custom setting really encodes at, for this capture size. */
export function customBitrateKbps(percent: number, width: number, height: number): number {
  return ratioBitrateKbps(customQualityRatio(percent), width, height);
}

/** An ffmpeg bitrate string (`-b:v`/`-maxrate`) for a custom setting. */
export function customBitrateArg(percent: number, width: number, height: number): string {
  return `${customBitrateKbps(percent, width, height)}k`;
}

export function clampCustomQualityPercent(value: unknown, allowMore = false): number {
  const max = allowMore ? CUSTOM_QUALITY_MAX_MORE_PERCENT : CUSTOM_QUALITY_MAX_PERCENT;
  if (typeof value !== "number" || !Number.isFinite(value)) return CUSTOM_QUALITY_DEFAULT_PERCENT;
  return Math.min(Math.max(Math.round(value), CUSTOM_QUALITY_MIN_PERCENT), max);
}

export function clampCustomFps(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return CUSTOM_FPS_DEFAULT;
  return Math.min(Math.max(Math.round(value), CUSTOM_FPS_MIN), CUSTOM_FPS_MAX);
}
