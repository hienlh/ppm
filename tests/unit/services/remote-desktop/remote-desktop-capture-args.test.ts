import { describe, it, expect } from "bun:test";
import { buildCaptureArgs } from "../../../../src/services/remote-desktop/remote-desktop-capture.ts";
import { captureEncoderArgs } from "../../../../src/services/remote-desktop/remote-desktop-encoder-args.ts";
import { captureInputForPlatform } from "../../../../src/services/remote-desktop/remote-desktop-capture-input.ts";

describe("buildCaptureArgs", () => {
  it("captures the desktop via gdigrab into an Annex-B H.264 pipe", () => {
    const args = buildCaptureArgs("/usr/bin/ffmpeg");
    expect(args[0]).toBe("/usr/bin/ffmpeg");
    expect(args).toContain("gdigrab");
    const i = args.indexOf("-i");
    expect(args[i + 1]).toBe("desktop");
    expect(args).toContain("libx264");
    expect(args).toContain("zerolatency");
    expect(args.at(-3)).toBe("-f");
    expect(args.at(-2)).toBe("h264");
    expect(args.at(-1)).toBe("pipe:1");
  });

  it("forces -bf 0 so every frame is exactly one VCL NAL (AU-assembly assumption)", () => {
    const args = buildCaptureArgs("ffmpeg");
    const bf = args.indexOf("-bf");
    expect(args[bf + 1]).toBe("0");
  });

  it("adds low-latency demux/mux flags so ffmpeg does not buffer frames before emitting", () => {
    const args = buildCaptureArgs("ffmpeg");
    const nb = args.indexOf("-fflags");
    expect(args[nb + 1]).toBe("nobuffer");
    const fp = args.indexOf("-flush_packets");
    expect(args[fp + 1]).toBe("1");
  });

  it("uses the detected hardware encoder args when one is passed", () => {
    const args = buildCaptureArgs("ffmpeg", "h264_nvenc");
    expect(args).toContain("h264_nvenc");
    expect(args).not.toContain("libx264");
  });

  it("captures a macOS screen via avfoundation by device NAME (indices shift at runtime), cursor included", () => {
    const args = buildCaptureArgs("ffmpeg", "h264_videotoolbox", { kind: "avfoundation", screen: "Capture screen 0" });
    expect(args).toContain("avfoundation");
    expect(args).not.toContain("gdigrab");
    expect(args[args.indexOf("-i") + 1]).toBe("Capture screen 0");
    expect(args[args.indexOf("-capture_cursor") + 1]).toBe("1");
    expect(args[args.indexOf("-pixel_format") + 1]).toBe("nv12");
    expect(args).toContain("h264_videotoolbox");
  });

  it("caps avfoundation to the target frame rate (device ignores -framerate, delivers at refresh rate)", () => {
    const args = buildCaptureArgs("ffmpeg", "h264_videotoolbox", { kind: "avfoundation", screen: "Capture screen 0" });
    expect(args[args.indexOf("-use_wallclock_as_timestamps") + 1]).toBe("1");
    expect(args[args.indexOf("-vf") + 1]).toBe("fps=30,scale=-2:720");
    // gdigrab honours -framerate, so it keeps the plain scale filter
    expect(buildCaptureArgs("ffmpeg")[buildCaptureArgs("ffmpeg").indexOf("-vf") + 1]).toBe("scale=-2:720");
  });
});

describe("captureInputForPlatform", () => {
  it("maps win32 → gdigrab, darwin → avfoundation main screen by name, others → null", () => {
    expect(captureInputForPlatform("win32")).toEqual({ kind: "gdigrab" });
    expect(captureInputForPlatform("darwin")).toEqual({ kind: "avfoundation", screen: "Capture screen 0" });
    expect(captureInputForPlatform("linux")).toBeNull();
  });
});

describe("captureEncoderArgs", () => {
  it("emits low-latency NVENC args for h264_nvenc (still -bf 0 for one slice/frame)", () => {
    const a = captureEncoderArgs("h264_nvenc");
    expect(a).toEqual(expect.arrayContaining(["-c:v", "h264_nvenc", "-tune", "ll", "-rc", "cbr"]));
    expect(a[a.indexOf("-bf") + 1]).toBe("0");
  });

  it("falls back to low-latency libx264 with sliced-threads disabled when no hw encoder", () => {
    const a = captureEncoderArgs();
    expect(a).toContain("libx264");
    expect(a).toContain("zerolatency");
    expect(a.join(" ")).toContain("sliced-threads=0");
  });
});
