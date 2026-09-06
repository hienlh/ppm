import { describe, it, expect } from "bun:test";
import { buildCaptureArgs } from "../../../../src/services/remote-desktop/remote-desktop-capture.ts";

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
});
