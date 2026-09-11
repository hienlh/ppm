/**
 * The remote-desktop quality ladder — shared, because both ends need the same table: the
 * server turns a rung into ffmpeg args, and the client renders the picker and shows which rung
 * is active. One definition so a label or a rung cannot drift between them.
 *
 * This is RustDesk's own set, ported rather than invented: `toolbarImageQuality` in
 * `flutter/lib/common/widgets/toolbar.dart` builds exactly four radio items — Good image
 * quality, Balanced, Optimize reaction time, Custom — and `Quality` in
 * `libs/scrap/src/common/codec.rs` is the matching enum with the three ratios below.
 *
 * Two things follow from that, and both are the opposite of what this file used to do:
 *
 * 1. **A rung never changes the resolution.** It sets a bitrate ratio, and the stream stays at
 *    the host's native size. The old ladder capped height per rung (720p on `balanced`), which
 *    on a 3440x1440 host threw away 4.8x the pixels — and measured, it bought almost nothing:
 *    720p used 1.17 Mbit/s against 1.26 Mbit/s for native at the same cap, because a desktop is
 *    mostly static and H.264 spends bits on *change*, not on area. Neither came close to the
 *    cap it was given, so the downscale was pure loss.
 * 2. **There is no `auto` rung.** RustDesk has no such menu item because the adaptation is
 *    always running: the chosen quality is the *maximum* ratio (`video_qos.rs`: "user set image
 *    quality => update to the maximum ratio of the latest quality") and congestion lowers the
 *    effective ratio underneath it. A pin that switched adaptation *off* is what made a chosen
 *    rung flicker forever on a link that could not carry it.
 *
 * The *policy* built on top of this (how far the ratio may fall, and when it moves) is server
 * side only, in `src/services/remote-desktop/remote-desktop-quality.ts`.
 */

export type QualityPresetId = "best" | "balanced" | "low";

/** One entry of the Image quality menu: a label and the bitrate ratio it asks for. Deliberately
 *  carries no resolution and no bitrate — the real bitrate depends on the capture size, so it
 *  can only be resolved once the display is known (`resolveQuality`). */
export interface QualityRung {
  id: QualityPresetId;
  label: string;
  /** RustDesk's `BR_BEST` / `BR_BALANCED` / `BR_SPEED` from `codec.rs`, unchanged. */
  ratio: number;
}

/** What the capture layer needs: a frame rate and an ffmpeg bitrate string. A rung plus a
 *  capture size resolves to one of these; so does the custom dialog's percentage. */
export interface QualityPreset {
  fps: number;
  /** ffmpeg bitrate string, used for both `-b:v` and `-maxrate`. */
  bitrate: string;
}

export const QUALITY_PRESETS: Record<QualityPresetId, QualityRung> = {
  best: { id: "best", label: "Good image quality", ratio: 1.5 },
  balanced: { id: "balanced", label: "Balanced", ratio: 0.67 },
  low: { id: "low", label: "Optimize reaction time", ratio: 0.5 },
};

/* "Optimize reaction time" is RustDesk's own name for the 0.5 rung and it is now the right one,
 * where on the old ladder it would have been backwards. There, the low rungs downscaled and the
 * *high* rungs were the low-latency ones — measured 1440p60 `gap p50=16.6ms` against 720p30
 * `p50=33.3ms`. With resolution out of the picture the only thing a lower rung changes is how
 * many bytes have to cross the link per frame, so less really does mean sooner. */

/** RustDesk's menu order, which is best-first — not the worst-to-best order a ladder walks. */
export const QUALITY_PRESET_ORDER: readonly QualityPresetId[] = ["best", "balanced", "low"];

/** `Quality::default()` in `codec.rs` is `Balanced`. */
export const DEFAULT_PRESET_ID: QualityPresetId = "balanced";

/** `pub const FPS: u32 = 30` in `video_qos.rs` — what a named rung streams at. Only the custom
 *  dialog sets a frame rate directly; RustDesk otherwise adapts it, never exposes it. */
export const DEFAULT_FPS = 30;

/** Coerce whatever came over the wire into a real preset id, or null for garbage.
 *  `Object.hasOwn`, never `in`: `in` walks the prototype chain, so `"toString"` off the wire
 *  would pass as a preset id and `QUALITY_PRESETS["toString"]` would hand the capture pipeline
 *  a *function* where it expected a rung — nonsense ffmpeg args from one client string. */
export function parsePresetId(value: unknown): QualityPresetId | null {
  return typeof value === "string" && Object.hasOwn(QUALITY_PRESETS, value)
    ? value as QualityPresetId
    : null;
}

/** What the client can ask for. `custom` only means something together with the two numbers
 *  from its dialog, which is why it is a separate arm rather than a fourth rung. */
export type QualityChoice = QualityPresetId | "custom";

/** A custom rung: RustDesk's bitrate percentage + fps, at the host's native resolution — the
 *  same resolution every named rung uses (see `remote-desktop-custom-quality.ts`). */
export interface CustomQuality {
  /** Bitrate percentage; the real bitrate comes from the capture size. */
  percent: number;
  fps: number;
}

/** Coerce a stored/untrusted value into a `QualityChoice`, falling back to the default rung.
 *  Separate from `parsePresetId` because the persisted device pref may legitimately be
 *  `"custom"`, and because localStorage is user-writable — a rung read back from it is
 *  untrusted input exactly like one off the wire, with the same `Object.hasOwn` hazard behind
 *  it. A pref left over from the old five-rung ladder (`"tiny"`, `"max"`, `"auto"`) parses as
 *  garbage and lands on the default, which is what should happen to a rung that no longer
 *  exists. */
export function parseQualityChoice(value: unknown): QualityChoice {
  if (value === "custom") return value;
  return parsePresetId(value) ?? DEFAULT_PRESET_ID;
}

/** Next value for the mobile toolbar's one-tap-per-hop button, in menu order. A dropdown in the
 *  thumb zone is worse than a button that cycles.
 *
 *  `custom` is deliberately not in the cycle: it only means something together with the two
 *  numbers from its dialog, so a one-tap button that landed on it would change the stream to
 *  whatever was last typed there — surprising, and with no visible cause. */
export function nextQualityChoice(current: QualityChoice): QualityChoice {
  if (current === "custom") return QUALITY_PRESET_ORDER[0]!;
  const at = QUALITY_PRESET_ORDER.indexOf(current);
  return QUALITY_PRESET_ORDER[(at + 1) % QUALITY_PRESET_ORDER.length]!;
}

/** Compact label for a toolbar button, where the full label does not fit. RustDesk has no such
 *  button, so these are the shortest thing that still distinguishes the four. */
const SHORT_LABELS: Record<QualityPresetId, string> = {
  best: "Good",
  balanced: "Balanced",
  low: "Reaction",
};

export function shortQualityLabel(choice: QualityChoice): string {
  return choice === "custom" ? "Custom" : SHORT_LABELS[choice];
}
