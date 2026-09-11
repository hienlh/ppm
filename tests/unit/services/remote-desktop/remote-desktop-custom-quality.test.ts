/**
 * Ported from RustDesk (`codec.rs`, `video_qos.rs`, `consts.dart`). The two tests that matter
 * are the ratio one and the nearest-preset one: both encode a decision that a sensible guess
 * gets wrong, and neither would fail loudly — the stream would just be the wrong bitrate.
 */
import { describe, expect, test } from "bun:test";
import {
  CUSTOM_FPS_DEFAULT, CUSTOM_FPS_MAX, CUSTOM_FPS_MIN,
  CUSTOM_QUALITY_DEFAULT_PERCENT, CUSTOM_QUALITY_MAX_MORE_PERCENT, CUSTOM_QUALITY_MIN_PERCENT,
  baseBitrateKbps, clampCustomFps, clampCustomQualityPercent, customBitrateArg,
  customBitrateKbps, customQualityRatio,
} from "../../../../src/shared/remote-desktop-custom-quality.ts";

describe("customQualityRatio", () => {
  test("the dialog's default 50% is ratio 1.0, not 0.5", () => {
    // `((q >> 8 & 0xFFF) * 2) / 100` — the whole reason this is ported and not guessed.
    expect(customQualityRatio(50)).toBeCloseTo(1.0, 10);
    expect(customQualityRatio(100)).toBeCloseTo(2.0, 10);
    expect(customQualityRatio(10)).toBeCloseTo(0.2, 10);
  });

  test("2000% lands exactly on BR_MAX, which is what 'More' unlocks", () => {
    expect(customQualityRatio(CUSTOM_QUALITY_MAX_MORE_PERCENT)).toBe(40);
  });

  test("clamps to RustDesk's BR_MIN/BR_MAX rather than trusting the input", () => {
    expect(customQualityRatio(0)).toBe(0.2);
    expect(customQualityRatio(-100)).toBe(0.2);
    expect(customQualityRatio(99999)).toBe(40);
    expect(customQualityRatio(NaN)).toBeCloseTo(1.0, 10);
  });
});

describe("baseBitrateKbps", () => {
  test("matches the table exactly on a listed resolution", () => {
    expect(baseBitrateKbps(1920, 1080)).toBe(2073);
    expect(baseBitrateKbps(3440, 1440)).toBe(4000);
    expect(baseBitrateKbps(1280, 720)).toBe(1000);
    expect(baseBitrateKbps(3840, 2160)).toBe(5000);
  });

  test("is non-linear in pixels, so a bits-per-pixel constant cannot replace it", () => {
    // 4K has 4x the pixels of 1080p but only ~2.4x the bitrate. A linear model would
    // over-spend by ~65% at 4K, which is exactly the kind of thing nothing reports.
    const ratio = baseBitrateKbps(3840, 2160) / baseBitrateKbps(1920, 1080);
    expect(ratio).toBeLessThan(2.6);
    expect(ratio).toBeGreaterThan(2.3);
  });

  test("scales the nearest preset by the pixel ratio for an unlisted size", () => {
    // 2560x1080 (2.76M px) is nearest 2K DCI (2048x1080 = 2.21M px, 2200 kbps).
    expect(baseBitrateKbps(2560, 1080)).toBe(Math.round(2200 * ((2560 * 1080) / (2048 * 1080))));
  });

  test("never returns zero for a degenerate size", () => {
    // A 0x0 capture happens before the first frame; a 0 bitrate would make ffmpeg refuse.
    expect(baseBitrateKbps(0, 0)).toBeGreaterThan(0);
  });

  test("picks the nearest row, not the next one up", () => {
    // 1366x768 (1.049M) and 1280x720 (0.921M) are adjacent rows; a size between them must
    // land on whichever is closer in pixels.
    expect(baseBitrateKbps(1366, 768)).toBe(1100);
    expect(baseBitrateKbps(1280, 720)).toBe(1000);
  });
});

describe("customBitrateKbps", () => {
  test("50% on a 3440x1440 host is the base bitrate", () => {
    expect(customBitrateKbps(50, 3440, 1440)).toBe(4000);
  });

  test("100% doubles it", () => {
    expect(customBitrateKbps(100, 3440, 1440)).toBe(8000);
  });

  test("emits an ffmpeg-shaped bitrate string", () => {
    expect(customBitrateArg(50, 1920, 1080)).toBe("2073k");
  });
});

describe("clamping untrusted stored values", () => {
  test("the percent ceiling depends on the More checkbox", () => {
    expect(clampCustomQualityPercent(500)).toBe(100);
    expect(clampCustomQualityPercent(500, true)).toBe(500);
    expect(clampCustomQualityPercent(99999, true)).toBe(CUSTOM_QUALITY_MAX_MORE_PERCENT);
    expect(clampCustomQualityPercent(1)).toBe(CUSTOM_QUALITY_MIN_PERCENT);
  });

  test("anything that is not a finite number falls back to the default", () => {
    // localStorage is user-writable, so these are real inputs, not defensive noise.
    for (const bad of [NaN, Infinity, "80", null, undefined, {}]) {
      expect(clampCustomQualityPercent(bad)).toBe(CUSTOM_QUALITY_DEFAULT_PERCENT);
      expect(clampCustomFps(bad)).toBe(CUSTOM_FPS_DEFAULT);
    }
  });

  test("fps stays inside RustDesk's 5-120", () => {
    expect(clampCustomFps(1)).toBe(CUSTOM_FPS_MIN);
    expect(clampCustomFps(240)).toBe(CUSTOM_FPS_MAX);
    expect(clampCustomFps(59.6)).toBe(60);
  });
});

describe("the custom rung reaches ffmpeg", () => {
  test("a custom preset puts the computed bitrate on -b:v and -maxrate", async () => {
    const { buildCaptureArgs } = await import(
      "../../../../src/services/remote-desktop/remote-desktop-capture.ts");
    const { QUALITY_PRESETS } = await import("../../../../src/shared/remote-desktop-quality.ts");
    // The shape `RemoteDesktopSession.effectivePreset()` builds for a 3440x1440 host at 50%.
    const preset = {
      ...QUALITY_PRESETS.balanced,
      height: 1440,
      fps: 30,
      bitrate: customBitrateArg(50, 3440, 1440),
    };
    const argv = buildCaptureArgs("ffmpeg", "libx264", { kind: "gdigrab" }, preset, true);
    const joined = argv.join(" ");
    // 50% of 3440x1440 is the table's own 4000 kbps — ratio 1.0, not 0.5.
    expect(preset.bitrate).toBe("4000k");
    expect(joined).toContain("-b:v 4000k");
    expect(joined).toContain("-maxrate 4000k");
  });

  test("100% really is twice the bitrate of 50% in the args", () => {
    expect(customBitrateArg(100, 3440, 1440)).toBe("8000k");
    expect(customBitrateArg(50, 3440, 1440)).toBe("4000k");
  });
});
