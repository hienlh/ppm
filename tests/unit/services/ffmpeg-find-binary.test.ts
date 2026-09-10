import { describe, it, expect } from "bun:test";
import { findFfmpegBinary } from "../../../src/services/media-transcode/ffmpeg-capabilities.ts";

describe("findFfmpegBinary", () => {
  it("falls back to well-known directories when PATH does not have it (launchd daemons)", () => {
    // Wherever ffmpeg really is on this runner, the same lookup restricted to its own directory
    // must find it while a PATH-only lookup with an empty PATH does not.
    const onPath = Bun.which("ffmpeg");
    if (!onPath) return; // nothing to assert against on a runner without ffmpeg
    const dir = onPath.slice(0, onPath.lastIndexOf(process.platform === "win32" ? "\\" : "/"));
    const launchdPath = "/usr/bin:/bin:/usr/sbin:/sbin".includes(dir) ? "/nonexistent" : "/usr/bin:/bin:/usr/sbin:/sbin";
    expect(findFfmpegBinary("ffmpeg", [], launchdPath)).toBeNull();
    expect(findFfmpegBinary("ffmpeg", [dir], launchdPath)).toBe(onPath);
    expect(findFfmpegBinary("ffmpeg", ["/nonexistent"], launchdPath)).toBeNull();
  });
});
