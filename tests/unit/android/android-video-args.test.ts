import { describe, expect, test } from "bun:test";
import { STREAM_BOX, encoderArgs, fitLongEdge, pickEncoder } from "../../../src/services/android/android-video.ts";
import { ANDROID_QUALITY_PRESETS } from "../../../src/shared/android-protocol.ts";

function pairs(args: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < args.length - 1; i++) if (args[i]!.startsWith("-")) m.set(args[i]!, args[i + 1]!);
  return m;
}

describe("encoder arguments", () => {
  // The proto says the buffer is "left to right and bottom up". Measured against
  // `adb exec-out screencap` on emulator 36.5.10 it is top-down (mean difference 1.21 per pixel
  // aligned, 37.15 flipped), so a vflip would render every screen upside down.
  test("no encoder flips the buffer, and each has exactly one filter chain", () => {
    for (const encoder of ["libx264", "h264_vaapi", "h264_qsv", "h264_nvenc"]) {
      const args = encoderArgs({ encoder, width: 720, height: 1600, fps: 30, bitrate: "4M" });
      expect(args.filter((a) => a === "-vf")).toHaveLength(1);   // a second -vf REPLACES the first
      expect(pairs(args).get("-vf")).not.toContain("vflip");
    }
  });

  // CLAUDE.md, remote desktop: -vaapi_device opens during input setup, the upload must share the
  // one -vf chain, and a software pix_fmt makes ffmpeg reject the hardware frame context.
  test("VAAPI puts its device before -i, uploads in the same chain, and sets no pix_fmt output", () => {
    const args = encoderArgs({ encoder: "h264_vaapi", width: 720, height: 1600, fps: 30, bitrate: "4M" });
    expect(args.indexOf("-vaapi_device")).toBeLessThan(args.indexOf("-i"));
    expect(pairs(args).get("-vf")).toBe("format=nv12,hwupload");
    expect(args.lastIndexOf("-pix_fmt")).toBeLessThan(args.indexOf("-i"));   // input only
  });

  test("the frame size and a half-second GOP reach ffmpeg", () => {
    const args = encoderArgs({ encoder: "libx264", width: 864, height: 1920, fps: 30, bitrate: "8M" });
    expect(pairs(args).get("-s")).toBe("864x1920");
    expect(pairs(args).get("-g")).toBe("15");
    expect(pairs(args).get("-b:v")).toBe("8M");
    expect(pairs(args).get("-pix_fmt")).toBe("rgb24");
  });

  test("a GOP never rounds to zero, which ffmpeg rejects", () => {
    expect(pairs(encoderArgs({ encoder: "libx264", width: 2, height: 2, fps: 1, bitrate: "1M" })).get("-g")).toBe("1");
  });
});

describe("fitting a rung's ceiling", () => {
  // The ceiling is on the LONG edge, so a rotation does not change how much detail a rung buys.
  test("a portrait frame is capped on its height, a landscape one on its width", () => {
    expect(fitLongEdge(864, 1920, 1280)).toEqual({ width: 576, height: 1280 });
    expect(fitLongEdge(1920, 864, 1280)).toEqual({ width: 1280, height: 576 });
  });

  test("a rung above the source never upscales", () => {
    expect(fitLongEdge(480, 800, 1920)).toEqual({ width: 480, height: 800 });
  });

  test("dimensions are always even — H.264 chroma is subsampled and rejects odd sizes", () => {
    const r = fitLongEdge(1081, 2401, 1280);
    expect(r.width % 2).toBe(0);
    expect(r.height % 2).toBe(0);
    expect(fitLongEdge(1, 1, 1280)).toEqual({ width: 2, height: 2 });
  });

  // The stream is opened once and never reopened (a cancelled screenshot stream on emulator
  // 36.5.10 cannot be replaced), so the one box requested has to serve the highest rung.
  test("the stream box covers every rung", () => {
    for (const preset of Object.values(ANDROID_QUALITY_PRESETS)) {
      expect(STREAM_BOX).toBeGreaterThanOrEqual(preset.maxHeight);
    }
  });
});

describe("scaling", () => {
  test("a rung below the source scales inside the one filter chain", () => {
    const args = encoderArgs({
      encoder: "libx264", width: 864, height: 1920, outWidth: 576, outHeight: 1280,
      fps: 30, bitrate: "4M",
    });
    expect(pairs(args).get("-s")).toBe("864x1920");          // input is what arrives
    expect(pairs(args).get("-vf")).toBe("scale=576:1280,format=yuv420p");
    expect(args.filter((a) => a === "-vf")).toHaveLength(1);
  });

  test("no scale filter at all when the sizes already match", () => {
    const args = encoderArgs({
      encoder: "libx264", width: 576, height: 1280, outWidth: 576, outHeight: 1280,
      fps: 30, bitrate: "4M",
    });
    expect(pairs(args).get("-vf")).toBe("format=yuv420p");
  });

  test("VAAPI scales in software before the upload, still in one chain", () => {
    const args = encoderArgs({
      encoder: "h264_vaapi", width: 864, height: 1920, outWidth: 324, outHeight: 720,
      fps: 24, bitrate: "1.5M",
    });
    expect(pairs(args).get("-vf")).toBe("scale=324:720,format=nv12,hwupload");
  });
});

describe("encoder choice", () => {
  test("hardware wins, and only among encoders that really encode here", () => {
    expect(pickEncoder(["libx264", "h264_vaapi"])).toBe("h264_vaapi");
    expect(pickEncoder(["libx264", "h264_nvenc", "h264_qsv"])).toBe("h264_qsv");
    expect(pickEncoder(["libx264"])).toBe("libx264");
  });

  test("a host with no working encoder still yields a command, not a crash", () => {
    expect(pickEncoder([])).toBe("libx264");
  });
});

describe("input frame rate", () => {
  test("declares the rate it feeds, so ffmpeg does not conform the output to 25 fps", () => {
    // Measured: without this, feeding a real 30 fps produced 151 access units from 180 frames —
    // the rawvideo demuxer assumes 25 fps and the default CFR sync drops the difference, unevenly
    // and silently. It has to sit before `-i`, i.e. be an *input* option.
    for (const fps of [24, 30, 60]) {
      const args = encoderArgs({ encoder: "h264_vaapi", width: 855, height: 1920, fps, bitrate: "4M" });
      const at = args.indexOf("-framerate");
      expect(at).toBeGreaterThan(-1);
      expect(args[at + 1]).toBe(String(fps));
      expect(at).toBeLessThan(args.indexOf("-i"));
    }
  });
});
