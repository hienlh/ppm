/**
 * The quality ladder and the policy over it, both now RustDesk's.
 *
 * Two things these tests deliberately do and do not claim. They pin the ladder — RustDesk's four
 * options, its three ratios, and the absence of any resolution change — which is the part that
 * measurably fixed the reported flicker: the top rung now asks for `base_bitrate(3440,1440) *
 * 1.5` = 6 Mbit/s instead of a flat 25, and the stream holds 30.0 fps with a 42 ms maximum gap
 * over both a 5 Mbit/s and a 2 Mbit/s link, where the old top rung managed 22.9 of 60 fps with
 * gaps to 181 ms over 4 Mbit/s.
 *
 * `nextRatioScale` is a different matter. It exists because choosing a rung used to set
 * `autoQuality = false` and switch the adaptation off entirely, which is a real defect — but no
 * end-to-end run has ever exercised it, because `congestionState` did not fire even at
 * 0.4 Mbit/s behind a relay applying real TCP backpressure (`getBufferedAmount()` is Bun's
 * userspace queue and drains into the kernel buffer). So these are unit tests of a policy whose
 * *input signal* is unproven, and the last test is the one that matters: the relief cannot be
 * switched off by anything a client sends.
 */
import { describe, it, expect } from "bun:test";
import {
  CHANGE_COOLDOWN_MS, CONGESTION_MIN_SCALE, CONGESTION_STEP, DEFAULT_FPS, DEFAULT_PRESET_ID,
  DEGRADE_EVENT_THRESHOLD, QUALITY_PRESETS, UPGRADE_QUIET_MS, initialAdaptiveState,
  nextRatioScale, noteBackpressure, parsePresetId, type AdaptiveState,
  BACKPRESSURE_SUSTAIN_MS, BACKPRESSURE_THRESHOLD_BYTES, congestionState,
} from "../../../../src/services/remote-desktop/remote-desktop-quality.ts";
import {
  QUALITY_PRESET_ORDER, nextQualityChoice, shortQualityLabel,
} from "../../../../src/shared/remote-desktop-quality.ts";
import {
  baseBitrateKbps, ratioBitrateArg,
} from "../../../../src/shared/remote-desktop-custom-quality.ts";
import { buildCaptureArgs } from "../../../../src/services/remote-desktop/remote-desktop-capture.ts";

const X11 = { kind: "x11grab" as const, display: ":0", rect: null };
/** What a session resolves a rung into once it knows the display — see `effectivePreset`. */
const resolved = (ratio: number, w = 3440, h = 1440) =>
  ({ fps: DEFAULT_FPS, bitrate: ratioBitrateArg(ratio, w, h) });

describe("the quality ladder", () => {
  it("is RustDesk's four options and nothing else", () => {
    // `toolbarImageQuality` in flutter/lib/common/widgets/toolbar.dart, in its order.
    expect(QUALITY_PRESET_ORDER).toEqual(["best", "balanced", "low"]);
    expect(QUALITY_PRESET_ORDER.map((id) => QUALITY_PRESETS[id].label)).toEqual([
      "Good image quality", "Balanced", "Optimize reaction time",
    ]);
    // The fourth is `custom`, which is not a rung because it means nothing without its numbers.
    expect(parsePresetId("custom")).toBeNull();
  });

  it("carries RustDesk's own ratios, unchanged", () => {
    // BR_BEST / BR_BALANCED / BR_SPEED in libs/scrap/src/common/codec.rs.
    expect(QUALITY_PRESETS.best.ratio).toBe(1.5);
    expect(QUALITY_PRESETS.balanced.ratio).toBe(0.67);
    expect(QUALITY_PRESETS.low.ratio).toBe(0.5);
    // `Quality::default()` is Balanced.
    expect(DEFAULT_PRESET_ID).toBe("balanced");
  });

  it("never changes the resolution, on any rung", () => {
    // The whole reason the old ladder looked bad: it capped height per rung, so a 3440x1440
    // host streamed 720p on `balanced`. Measured, that bought 1.17 Mbit/s against 1.26 Mbit/s
    // for native at the same cap — 7% of the bandwidth for 4.8x the pixels thrown away.
    for (const id of QUALITY_PRESET_ORDER) {
      const args = buildCaptureArgs("ffmpeg", "libx264", X11, resolved(QUALITY_PRESETS[id].ratio));
      expect(args.join(" ")).not.toContain("scale=");
      // And with nothing left to filter the flag itself must be absent: ffmpeg rejects `-vf ""`.
      expect(args).not.toContain("-vf");
    }
  });

  it("turns a ratio into the bitrate ffmpeg is actually given", () => {
    // base_bitrate(3440,1440) = 4000 kbps, so `balanced` is 4000 * 0.67 = 2680k.
    expect(baseBitrateKbps(3440, 1440)).toBe(4000);
    const args = buildCaptureArgs("ffmpeg", "libx264", X11, resolved(QUALITY_PRESETS.balanced.ratio));
    expect(args[args.indexOf("-b:v") + 1]).toBe("2680k");
    expect(args[args.indexOf("-maxrate") + 1]).toBe("2680k");
    // The same rung on a smaller host asks for less, because the base moves with the size.
    const small = buildCaptureArgs("ffmpeg", "libx264", X11, resolved(0.67, 1280, 720));
    expect(small[small.indexOf("-b:v") + 1]).toBe("670k");
  });

  it("keeps the keyframe interval at half a second", () => {
    // Tied to the frame rate, not a fixed count: the backpressure path discards deltas until
    // the next keyframe, so this is what bounds how long a client stares at a frozen picture.
    const args = buildCaptureArgs("ffmpeg", "libx264", X11, resolved(QUALITY_PRESETS.best.ratio));
    expect(args[args.indexOf("-g") + 1]).toBe(String(Math.round(DEFAULT_FPS / 2)));
    expect(args[args.indexOf("-framerate") + 1]).toBe(String(DEFAULT_FPS));
  });

  it("parses only real preset ids", () => {
    expect(parsePresetId("low")).toBe("low");
    expect(parsePresetId("auto")).toBeNull(); // there is no `auto` any more
    expect(parsePresetId("max")).toBeNull(); // nor the old five-rung names
    expect(parsePresetId("")).toBeNull();
    expect(parsePresetId(7)).toBeNull();
    expect(parsePresetId(undefined)).toBeNull();
    // Must not resolve inherited Object properties into a preset.
    expect(parsePresetId("toString")).toBeNull();
  });
});

describe("nextRatioScale — the chosen rung is a ceiling, not a freeze", () => {
  const T0 = 1_000_000;
  /** Past the cooldown, with no backpressure recorded. */
  const settled = (at = T0): AdaptiveState => ({ events: [], lastChangeAt: at - CHANGE_COOLDOWN_MS - 1 });
  const bad = (state: AdaptiveState, at: number): AdaptiveState => {
    let s = state;
    for (let i = 0; i < DEGRADE_EVENT_THRESHOLD; i++) s = noteBackpressure(s, at + i);
    return s;
  };

  it("relieves congestion the same way whatever rung is chosen", () => {
    // The regression guard. This function takes no rung id at all, so there is no longer any
    // value a client can send that switches the relief off — which is what made a chosen rung
    // flicker forever on a link that could not carry it.
    expect(nextRatioScale.length).toBe(3);
    const state = bad(settled(), T0);
    expect(nextRatioScale(1, state, T0 + DEGRADE_EVENT_THRESHOLD)).toBeCloseTo(CONGESTION_STEP, 10);
  });

  it("steps down after sustained backpressure, not on a single hiccup", () => {
    let state = settled();
    state = noteBackpressure(state, T0);
    expect(nextRatioScale(1, state, T0)).toBeNull(); // one event is a scroll
    state = bad(settled(), T0);
    expect(nextRatioScale(1, state, T0 + DEGRADE_EVENT_THRESHOLD)).toBeCloseTo(0.6, 10);
  });

  it("stops at the floor instead of reporting a change forever", () => {
    const state = bad(settled(), T0);
    expect(nextRatioScale(CONGESTION_MIN_SCALE, state, T0 + 10)).toBeNull();
    // And a step that would undershoot lands exactly on the floor rather than below it:
    // 0.25 is above the floor so it is not held, but 0.25 * 0.6 = 0.15 is below it.
    const justAbove = CONGESTION_MIN_SCALE + 0.05;
    expect(justAbove * CONGESTION_STEP).toBeLessThan(CONGESTION_MIN_SCALE);
    expect(nextRatioScale(justAbove, state, T0 + 10)).toBe(CONGESTION_MIN_SCALE);
  });

  it("holds still inside the cooldown, however bad the link looks", () => {
    // Every change respawns ffmpeg for ~400ms; a flapping link must not do it twice a second.
    let state: AdaptiveState = { events: [], lastChangeAt: T0 };
    state = bad(state, T0);
    expect(nextRatioScale(1, state, T0 + CHANGE_COOLDOWN_MS - 1)).toBeNull();
    // Still bad when the cooldown expires — events have to be *recent*, not merely to have
    // happened once, which is why they are pruned to DEGRADE_WINDOW_MS.
    state = bad(state, T0 + CHANGE_COOLDOWN_MS);
    expect(nextRatioScale(1, state, T0 + CHANGE_COOLDOWN_MS + 1)).toBeCloseTo(0.6, 10);
  });

  it("a bad patch that stopped does not degrade once the cooldown expires", () => {
    // Three events, then silence. By the time the cooldown is up they are older than the
    // window, so the link is judged on the present rather than the past.
    const state = bad({ events: [], lastChangeAt: T0 }, T0);
    expect(nextRatioScale(1, state, T0 + CHANGE_COOLDOWN_MS + 1)).toBeNull();
  });

  it("climbs back only after a long quiet stretch, and never past the rung", () => {
    const stateAt = (lastEvent: number): AdaptiveState =>
      ({ events: [lastEvent], lastChangeAt: T0 - CHANGE_COOLDOWN_MS - 1 });
    expect(nextRatioScale(0.6, stateAt(T0 - UPGRADE_QUIET_MS + 500), T0)).toBeNull();
    expect(nextRatioScale(0.6, stateAt(T0 - UPGRADE_QUIET_MS - 1), T0)).toBeCloseTo(1, 10);
    // Already at the ceiling: a quiet link is not a reason to spend more than was asked for.
    expect(nextRatioScale(1, stateAt(T0 - UPGRADE_QUIET_MS - 1), T0)).toBeNull();
  });

  it("recovers in steps, and each step is capped at the ceiling", () => {
    const quiet: AdaptiveState = { events: [], lastChangeAt: T0 - UPGRADE_QUIET_MS - 1 };
    const up = nextRatioScale(0.36, quiet, T0);
    expect(up).toBeCloseTo(0.6, 10);
    expect(nextRatioScale(up!, { ...quiet }, T0)).toBeCloseTo(1, 10);
  });

  it("initialAdaptiveState starts inside the cooldown so nothing changes immediately", () => {
    expect(nextRatioScale(1, initialAdaptiveState(T0), T0)).toBeNull();
  });

  it("forgets old backpressure, so a bad minute ago does not degrade a good one now", () => {
    let state = bad(settled(), T0);
    // One fresh event far later prunes the stale ones inside noteBackpressure.
    state = noteBackpressure(state, T0 + 60_000);
    expect(state.events).toHaveLength(1);
    expect(nextRatioScale(1, state, T0 + 60_000)).toBeNull();
  });
});

describe("the mobile toolbar's cycling button", () => {
  it("walks the three rungs and wraps, visiting each exactly once", () => {
    const seen: string[] = [];
    let choice = nextQualityChoice(QUALITY_PRESET_ORDER[0]!);
    seen.push(QUALITY_PRESET_ORDER[0]!);
    for (let i = 1; i < QUALITY_PRESET_ORDER.length; i++) { seen.push(choice); choice = nextQualityChoice(choice); }
    expect(seen).toEqual([...QUALITY_PRESET_ORDER]);
    expect(choice).toBe(QUALITY_PRESET_ORDER[0]);
  });

  it("leaves custom on the first tap, since its numbers live in a dialog", () => {
    expect(nextQualityChoice("custom")).toBe(QUALITY_PRESET_ORDER[0]);
  });

  it("has a short name for each of the four", () => {
    expect(shortQualityLabel("best")).toBe("Good");
    expect(shortQualityLabel("balanced")).toBe("Balanced");
    expect(shortQualityLabel("low")).toBe("Reaction");
    expect(shortQualityLabel("custom")).toBe("Custom");
  });
});

describe("congestionState — a spike must not cost a resync", () => {
  const OVER = BACKPRESSURE_THRESHOLD_BYTES + 1;

  it("does not call a fresh backlog congested", () => {
    // The frame that first sees a full buffer is exactly the one that must still be sent.
    expect(congestionState(null, OVER, 1000)).toEqual({ since: 1000, congested: false });
  });

  it("rides out a spike shorter than the sustain window", () => {
    // 120ms of backpressure used to freeze the picture for 502ms; now it costs nothing.
    let since: number | null = null;
    for (let t = 0; t < 120; t += 33) {
      const r = congestionState(since, OVER, t);
      since = r.since;
      expect(r.congested).toBe(false);
    }
    // ...and the marker clears the moment the socket drains, so the next spike starts over.
    expect(congestionState(since, 0, 130)).toEqual({ since: null, congested: false });
  });

  it("does call a backlog that persists congested", () => {
    const r = congestionState(1000, OVER, 1000 + BACKPRESSURE_SUSTAIN_MS);
    expect(r).toEqual({ since: 1000, congested: true });
  });

  it("treats exactly the threshold as fine, not congested", () => {
    expect(congestionState(null, BACKPRESSURE_THRESHOLD_BYTES, 5)).toEqual({ since: null, congested: false });
  });

  it("waits out less time than the keyframe it would otherwise cost", () => {
    // The whole point: paying 250ms of queue beats paying a half-second GOP resync.
    const halfSecondGop = 500;
    expect(BACKPRESSURE_SUSTAIN_MS).toBeLessThan(halfSecondGop);
  });
});
