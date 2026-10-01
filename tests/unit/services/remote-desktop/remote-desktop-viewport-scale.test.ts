/**
 * The viewer-adaptive capture bound. Two things are being pinned here and they pull in opposite
 * directions: a frame too wide for the browser's decoder must always be cut down (that is a
 * black picture, not a slow one), and a host that was already working must keep the argv it
 * had — a new `scale` step on every session puts swscale in the path of grabbers that never
 * needed it.
 */
import { describe, expect, it } from "bun:test";
import {
  captureBound, captureScaleFilter, MAX_DECODABLE_HEIGHT, MAX_DECODABLE_WIDTH,
  MIN_VIEWPORT_WIDTH, parseViewportSize, quantiseViewport, VIEWPORT_STEP,
} from "../../../../src/shared/remote-desktop-viewport-scale.ts";
import { buildCaptureArgs } from "../../../../src/services/remote-desktop/remote-desktop-capture.ts";
import { captureVideoFilter } from "../../../../src/services/remote-desktop/remote-desktop-capture-input.ts";

const AVF = { kind: "avfoundation", screen: "Capture screen 0" } as const;
const X11 = { kind: "x11grab", display: ":0", rect: null } as const;

describe("parseViewportSize", () => {
  it("accepts a pair of pixel counts", () => {
    expect(parseViewportSize({ width: 1280, height: 720 })).toEqual({ width: 1280, height: 720 });
  });

  it("rounds fractional CSS-pixel arithmetic", () => {
    expect(parseViewportSize({ width: 1279.6, height: 719.2 })).toEqual({ width: 1280, height: 719 });
  });

  it("refuses everything that is not a usable pair", () => {
    // All of these arrive off the wire in practice: an older client sends nothing, a collapsed
    // pane reports 0, and a hand-edited localStorage can send anything at all.
    for (const bad of [
      undefined, null, 42, "1280x720", [], { width: 1280 }, { width: "1280", height: "720" },
      { width: NaN, height: 720 }, { width: Infinity, height: 720 },
      { width: 0, height: 720 }, { width: -1280, height: 720 }, { width: 40_000, height: 720 },
    ]) {
      expect(parseViewportSize(bad)).toBeNull();
    }
  });
});

describe("quantiseViewport", () => {
  it("rounds up to the next step, so the stream is never softer than its window", () => {
    expect(quantiseViewport({ width: 1281, height: 721 }).width).toBe(1280 + VIEWPORT_STEP);
  });

  it("answers the same bucket for a window nudged a few pixels", () => {
    // This is what stops a window drag respawning ffmpeg per frame.
    expect(quantiseViewport({ width: 1600, height: 900 }))
      .toEqual(quantiseViewport({ width: 1590, height: 890 }));
  });

  it("floors a collapsed pane rather than asking for a few pixels", () => {
    expect(quantiseViewport({ width: 8, height: 4 }).width).toBe(MIN_VIEWPORT_WIDTH);
  });

  it("never exceeds what a decoder takes, however large the window", () => {
    const huge = quantiseViewport({ width: 10_000, height: 9_000 });
    expect(huge.width).toBe(MAX_DECODABLE_WIDTH);
    expect(huge.height).toBe(MAX_DECODABLE_HEIGHT);
  });
});

describe("captureBound", () => {
  it("falls back to the decoder's own maximum when the viewer has not said", () => {
    // Not null: a client that sends no viewport (an older one, a reconnect mid-resize) still
    // has a decoder, and 5160x2160 is what it cannot take.
    expect(captureBound(null)).toEqual({ width: MAX_DECODABLE_WIDTH, height: MAX_DECODABLE_HEIGHT });
  });
});

describe("captureScaleFilter", () => {
  it("emits nothing when the source already fits", () => {
    expect(captureScaleFilter({ width: 4096, height: 4096 }, 3440, 1440)).toBe("");
  });

  it("emits nothing when the source is exactly the bound", () => {
    expect(captureScaleFilter({ width: 1920, height: 1080 }, 1920, 1080)).toBe("");
  });

  it("emits when the source is unknown, because it cannot be proven safe", () => {
    // gdigrab grabs the union of every monitor: two 4K screens side by side are 7680 wide.
    expect(captureScaleFilter({ width: 4096, height: 4096 })).toContain("min(iw,4096)");
  });

  it("bounds rather than resizes, so a small host is never upscaled", () => {
    const filter = captureScaleFilter({ width: 2560, height: 1440 }, 5160, 2160);
    expect(filter).toContain("min(iw,2560)");
    expect(filter).toContain("min(ih,1440)");
    expect(filter).toContain("force_original_aspect_ratio=decrease");
    // H.264 in yuv420p cannot encode an odd dimension, and `decrease` lands on odd numbers.
    expect(filter).toContain("force_divisible_by=2");
  });
});

describe("captureVideoFilter with a bound", () => {
  it("adds nothing at all when no bound is given", () => {
    expect(captureVideoFilter(X11, "libx264")).toBe("");
  });

  it("keeps the rate cap first on avfoundation", () => {
    const filter = captureVideoFilter(
      AVF, "h264_videotoolbox", { fps: 30, bitrate: "4M" },
      { width: 2560, height: 1440 }, { width: 5160, height: 2160 },
    );
    expect(filter.startsWith("fps=30,scale=")).toBe(true);
  });

  it("scales before the VAAPI upload, never after", () => {
    // `hwupload` puts the frames in GPU memory and a software scale cannot read them back.
    const filter = captureVideoFilter(
      X11, "h264_vaapi", { fps: 30, bitrate: "4M" },
      { width: 1920, height: 1080 }, { width: 3440, height: 1440 },
    );
    expect(filter.indexOf("scale=")).toBeLessThan(filter.indexOf("hwupload"));
  });
});

describe("buildCaptureArgs with a bound", () => {
  it("is byte-identical to the unbounded argv when the host already fits", () => {
    const preset = { fps: 30, bitrate: "4M" };
    const plain = buildCaptureArgs("ffmpeg", "libx264", X11, preset, true, null);
    const bounded = buildCaptureArgs(
      "ffmpeg", "libx264", X11, preset, true, null,
      { width: 4096, height: 4096 }, { width: 3440, height: 1440 },
    );
    expect(bounded).toEqual(plain);
    expect(bounded).not.toContain("-vf");
  });

  it("cuts a frame no browser decoder would take down to size", () => {
    const argv = buildCaptureArgs(
      "ffmpeg", "h264_videotoolbox", AVF, { fps: 30, bitrate: "4M" }, true, null,
      { width: MAX_DECODABLE_WIDTH, height: MAX_DECODABLE_HEIGHT }, { width: 5160, height: 2160 },
    );
    const filter = argv[argv.indexOf("-vf") + 1] ?? "";
    expect(filter).toContain(`min(iw,${MAX_DECODABLE_WIDTH})`);
  });
});
