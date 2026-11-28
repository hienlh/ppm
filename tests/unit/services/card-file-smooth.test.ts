/**
 * The "Smooth" copy of a card's video: pending while it is made, ready once it exists, none (with
 * a mark saying why) when the original is already light or the encode failed, made once however
 * many ask, never for a picture, gone with the card file. Also the File Explorer's Smooth stream:
 * the transcode held to ~4 Mbit/s, by the hardware encoder when there is one.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardFileSmoothPath, removeCardFile, storeCardFile } from "../../../src/services/assistant-cards/card-files-store.ts";
import { ensureSmoothCopy, smoothRunning, smoothState } from "../../../src/services/assistant-cards/card-file-smooth.ts";
import { SMOOTH_VIDEO_KBPS } from "../../../src/services/assistant-cards/card-file-video-compress.ts";
import { buildTranscodeArgs, SMOOTH_TRANSCODE_KBPS } from "../../../src/services/media-transcode/transcode-stream.ts";
import { encoderArgsAtBitrate } from "../../../src/services/media-transcode/ffmpeg-capabilities.ts";

const MP4 = Buffer.from([0, 0, 0, 0x18, ...Buffer.from("ftypisom"), 0, 0, 2, 0, ...Buffer.from("isomiso2")]);
let dir: string;
const kept: string[] = [];

async function video(name: string) {
  writeFileSync(join(dir, name), Buffer.concat([MP4, Buffer.from(name)]));
  const s = await storeCardFile(join(dir, name), name, dir);
  kept.push(s.id);
  return s;
}

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "card-smooth-")); });
afterAll(async () => { for (const id of kept) await removeCardFile(id); rmSync(dir, { recursive: true, force: true }); });

describe("the smooth copy of a card video", () => {
  it("is pending while it is made, made once however many ask, then ready", async () => {
    const file = await video("clip.mp4");
    expect(smoothState(file)).toBe("pending");
    let encodes = 0;
    let finish: () => void = () => {};
    const gate = new Promise<void>((r) => { finish = r; });
    const encode = async (_in: string, out: string) => { encodes++; await gate; await writeFile(out, MP4); return { ok: true as const, size: MP4.length }; };
    const a = ensureSmoothCopy(file, encode);
    const b = ensureSmoothCopy(file, encode);
    expect(smoothRunning(file.id)).toBe(true);
    expect(smoothState(file)).toBe("pending");
    finish();
    await Promise.all([a, b]);
    expect(encodes).toBe(1);
    expect(smoothState(file)).toBe("ready");
    expect(smoothRunning(file.id)).toBe(false);
    await removeCardFile(file.id);
    expect(existsSync(cardFileSmoothPath(file.id))).toBe(false);
  });

  it("is none, and stays none, when the original is already light or the encode failed", async () => {
    const light = await video("light.mp4");
    await ensureSmoothCopy(light, async () => ({ ok: false as const, skipped: true as const, why: "already light" }));
    expect(smoothState(light)).toBe("none");
    let again = 0;
    await ensureSmoothCopy(light, async () => { again++; return { ok: true as const, size: 1 }; });
    expect(again).toBe(0);
    const broken = await video("broken.mp4");
    await ensureSmoothCopy(broken, async () => ({ ok: false as const, why: "ffmpeg could not encode it" }));
    expect(smoothState(broken)).toBe("none");
  });

  it("is never made for a picture", async () => {
    let encodes = 0;
    const pic = { id: "f".repeat(32), kind: "image" as const };
    await ensureSmoothCopy(pic, async () => { encodes++; return { ok: true as const, size: 1 }; });
    expect(encodes).toBe(0);
    expect(smoothState(pic)).toBe("none");
  });
});

describe("the File Explorer's Smooth stream", () => {
  it("holds the transcode to ~4 Mbit/s instead of a quality, keeping the 1080p cap", () => {
    expect(SMOOTH_TRANSCODE_KBPS).toBe(4000);
    expect(SMOOTH_VIDEO_KBPS).toBe(4000);
    const normal = buildTranscodeArgs("ffmpeg", "in.mov", "h264_nvenc").join(" ");
    const smooth = buildTranscodeArgs("ffmpeg", "in.mov", "h264_nvenc", 12, "smooth").join(" ");
    expect(normal).toContain("-cq 26");
    expect(smooth).toContain("h264_nvenc");
    expect(smooth).toContain("-b:v 4000k -maxrate 5000k");
    expect(smooth).not.toContain("-cq");
    expect(smooth).toContain("-ss 12.000");
    expect(smooth).toContain("scale='min(1920,iw)':-2");
  });

  it("asks each encoder for a bitrate", () => {
    for (const enc of ["h264_nvenc", "h264_qsv", "h264_amf", "h264_videotoolbox", "h264_vaapi", "libx264"]) {
      const args = encoderArgsAtBitrate(enc, 4000).join(" ");
      expect(args).toContain("-b:v 4000k");
      expect(args).toContain("-maxrate 5000k");
    }
  });
});
