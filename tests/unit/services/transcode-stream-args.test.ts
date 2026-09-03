import { describe, it, expect } from "bun:test";
import { buildTranscodeArgs } from "../../../src/services/media-transcode/transcode-stream.ts";
import { encoderArgs } from "../../../src/services/media-transcode/ffmpeg-capabilities.ts";

describe("buildTranscodeArgs", () => {
  it("emits a browser-safe fragmented mp4 pipeline", () => {
    const args = buildTranscodeArgs("/usr/bin/ffmpeg", "/v/clip.avi", "libx264");
    expect(args[0]).toBe("/usr/bin/ffmpeg");
    expect(args).not.toContain("-ss");
    const i = args.indexOf("-i");
    expect(args[i + 1]).toBe("/v/clip.avi");
    expect(args).toContain("yuv420p");
    expect(args).toContain("libx264");
    expect(args.at(-3)).toBe("-f");
    expect(args.at(-2)).toBe("mp4");
    expect(args.at(-1)).toBe("pipe:1");
    const mov = args.indexOf("-movflags");
    expect(args[mov + 1]).toContain("frag_keyframe");
    expect(args[mov + 1]).toContain("empty_moov");
  });

  it("places -ss before -i for fast keyframe seeking", () => {
    const args = buildTranscodeArgs("ffmpeg", "C:\\v\\clip.avi", "h264_nvenc", 42.5);
    const ss = args.indexOf("-ss");
    expect(ss).toBeGreaterThan(0);
    expect(args[ss + 1]).toBe("42.500");
    expect(ss).toBeLessThan(args.indexOf("-i"));
    expect(args).toContain("h264_nvenc");
  });

  it("keeps the audio map optional so silent files still transcode", () => {
    const args = buildTranscodeArgs("ffmpeg", "x.mkv", "libx264");
    expect(args).toContain("0:a:0?");
  });
});

describe("encoderArgs", () => {
  it("falls back to libx264 flags for unknown encoders", () => {
    expect(encoderArgs("nonsense")).toContain("libx264");
  });
  it("names the requested hardware encoder", () => {
    for (const enc of ["h264_nvenc", "h264_qsv", "h264_amf", "h264_videotoolbox"]) {
      expect(encoderArgs(enc)).toContain(enc);
    }
  });
});
