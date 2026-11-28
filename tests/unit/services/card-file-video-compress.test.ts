/**
 * Compressing a card's video to fit Telegram's 50 MB at the best quality that fits: the length and
 * audio read from ffmpeg, the bitrate spread over the clip, a clip too long to watch refused, the
 * resolution kept, two passes; and (where ffmpeg is installed) a real compression that keeps a
 * portrait clip's size and comes out as an MP4 under the limit.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compressPlan, compressVideoForTelegram, hasAudioStream, MIN_VIDEO_KBPS, parseDurationSeconds, twoPassArgs,
} from "../../../src/services/assistant-cards/card-file-video-compress.ts";
import { findFfmpegBinary } from "../../../src/services/media-transcode/ffmpeg-capabilities.ts";
import { sniffCardFile, TELEGRAM_UPLOAD_MAX_BYTES, TELEGRAM_VIDEO_TARGET_BYTES } from "../../../src/shared/card-files.ts";

const MB = 1024 * 1024;

describe("the plan", () => {
  it("reads the length and whether there is audio from ffmpeg's banner", () => {
    expect(parseDurationSeconds("  Duration: 00:00:41.10, start: 0.000000, bitrate: 16176 kb/s")).toBeCloseTo(41.1);
    expect(parseDurationSeconds("Duration: 01:00:00.00,")).toBe(3600);
    expect(parseDurationSeconds("Duration: N/A, bitrate: N/A")).toBeNull();
    expect(hasAudioStream("  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz")).toBe(true);
    expect(hasAudioStream("  Stream #0:0[0x1](und): Video: h264 (High)")).toBe(false);
  });

  it("spends the target over the clip: an 83 MB, 41 s clip gets ~9 Mbit/s of picture", () => {
    const plan = compressPlan(41.1)!;
    expect(plan.audioKbps).toBe(128);
    expect(plan.videoKbps).toBeGreaterThan(8500);
    expect((plan.videoKbps + plan.audioKbps) * 41.1 * 1000 / 8).toBeLessThanOrEqual(TELEGRAM_VIDEO_TARGET_BYTES);
    expect(compressPlan(41.1, { audio: false })!.audioKbps).toBe(0);
    // A retry asks for less.
    expect(compressPlan(41.1, { scale: 0.9 })!.videoKbps).toBeLessThan(plan.videoKbps);
  });

  it("refuses a clip too long for a watchable picture", () => {
    const longest = (TELEGRAM_VIDEO_TARGET_BYTES * 8 * 0.98) / ((MIN_VIDEO_KBPS + 128) * 1000);
    expect(compressPlan(longest - 5)).not.toBeNull();
    expect(compressPlan(longest + 5)).toBeNull();
  });

  it("runs two passes at the same bitrate, keeps the resolution, and writes a faststart MP4", () => {
    const [first, second] = twoPassArgs("ffmpeg", "in.mp4", "out.mp4", "log", { videoKbps: 9000, audioKbps: 128 });
    expect(first.join(" ")).toContain("-pass 1 -an -f null -");
    expect(second.join(" ")).toContain("-pass 2");
    for (const args of [first, second]) {
      expect(args).toContain("libx264");
      expect(args.join(" ")).toContain("-b:v 9000k");
      expect(args.join(" ")).toContain("-passlogfile log");
      // No scale filter: a 1080×1920 clip stays 1080×1920.
      expect(args).not.toContain("-vf");
    }
    expect(second.join(" ")).toContain("-c:a aac -b:a 128k");
    expect(second.join(" ")).toContain("-movflags +faststart");
    expect(second.at(-1)).toBe("out.mp4");
  });
});

const ffmpeg = findFfmpegBinary("ffmpeg");
const ffprobe = findFfmpegBinary("ffprobe");

describe.skipIf(!ffmpeg)("with ffmpeg installed", () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "card-video-")); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("compresses a real portrait clip into an MP4 under the limit, at the same size, leaving no pass logs", async () => {
    const input = join(dir, "in.mkv");
    // Two seconds of a portrait test picture and a tone: small and quick to make.
    const made = Bun.spawnSync([ffmpeg!, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc=size=360x640:rate=15:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", input], { stdout: "ignore", stderr: "pipe" });
    if (made.exitCode !== 0) throw new Error(`could not make the test clip: ${made.stderr.toString()}`);
    const output = join(dir, "out.mp4");
    const res = await compressVideoForTelegram(input, output);
    expect(res).toMatchObject({ ok: true });
    if (res.ok) expect(res.size).toBeLessThanOrEqual(TELEGRAM_UPLOAD_MAX_BYTES);
    expect(sniffCardFile(readFileSync(output).subarray(0, 32)).mime).toBe("video/mp4");
    if (ffprobe) {
      const dims = Bun.spawnSync([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", output]).stdout.toString().trim();
      expect(dims).toBe("360,640");
    }
    expect(readdirSync(dir).filter((n) => n.includes("passlog") || n.endsWith(".part.mp4"))).toEqual([]);
  }, 90_000);

  it("says why when the input is not a video", async () => {
    const input = join(dir, "not-video.mp4");
    await Bun.write(input, "plain text, not a video");
    const res = await compressVideoForTelegram(input, join(dir, "never.mp4"));
    expect(res.ok).toBe(false);
  }, 30_000);
});
