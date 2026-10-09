import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AccessUnitAssembler, type AccessUnit } from "../../../../src/services/remote-desktop/access-unit-assembler.ts";
import { buildWaylandCaptureArgs } from "../../../../src/services/remote-desktop/remote-desktop-capture-wayland.ts";
import { captureEncoderArgs } from "../../../../src/services/remote-desktop/remote-desktop-encoder-args.ts";
import { encoderArgs as androidEncoderArgs } from "../../../../src/services/android/android-video.ts";

/**
 * The encoders PPM really drives, through the assembler, with a test pattern in place of the
 * screen or the phone. x264 under `tune=zerolatency` cuts a frame into one slice per thread, and
 * the assembler used to send every slice as a frame of its own: a Wayland host showed a solid
 * green picture (#48), Chrome decoded nothing. A fixture of hand-made NALs cannot catch that —
 * it encodes the same assumption the assembler does — so this asks the encoders themselves, and
 * replays one recorded answer where no encoder is installed.
 */

const FRAMES = 12;
const ffmpeg = Bun.which("ffmpeg");
const gstLaunch = Bun.which("gst-launch-1.0");

/** Not every ffmpeg build carries libx264 (some Windows builds do not), and without it the
 *  encodes below fail rather than test anything. */
function ffmpegHasLibx264(): boolean {
  if (!ffmpeg) return false;
  try { return Bun.spawnSync([ffmpeg, "-hide_banner", "-encoders"], { stderr: "ignore" }).stdout.toString().includes("libx264"); } catch { return false; }
}
const libx264 = ffmpegHasLibx264();

function gstHas(element: string): boolean {
  if (!gstLaunch) return false;
  try { return Bun.spawnSync(["gst-inspect-1.0", element], { stdout: "ignore", stderr: "ignore" }).exitCode === 0; } catch { return false; }
}

async function encode(argv: string[]): Promise<AccessUnit[]> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const stdout = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  expect(await proc.exited).toBe(0);
  return new AccessUnitAssembler().push(stdout);
}

/** Against the frames the encoder was given. A count of pictures read from the stream's own slice
 *  headers would repeat `startsPicture`'s rule, and agree with it whether it is right or not. */
function expectOneUnitPerFrame(aus: AccessUnit[]): void {
  // The last frame stays pending: only the next one opening proves it is complete.
  expect(aus.length).toBe(FRAMES - 1);
}

const lavfi = (size: string) => [
  ffmpeg!, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=30`, "-frames:v", String(FRAMES),
];

describe("real encoders through AccessUnitAssembler", () => {
  it.skipIf(!libx264)("X11 capture's libx264 gives one access unit per frame", async () => {
    expectOneUnitPerFrame(await encode([
      ...lavfi("1280x720"), ...captureEncoderArgs("libx264", { fps: 30, bitrate: "2M" }), "-f", "h264", "pipe:1",
    ]));
  });

  it.skipIf(!libx264)("the Android viewer's libx264 fallback gives one access unit per frame", async () => {
    // Everything after the input is the viewer's own encode; only the source is swapped.
    const args = androidEncoderArgs({ encoder: "libx264", width: 720, height: 1280, fps: 30, bitrate: "2M" });
    expectOneUnitPerFrame(await encode([...lavfi("720x1280"), ...args.slice(args.indexOf("pipe:0") + 1)]));
  });

  it.skipIf(!gstHas("x264enc"))("the Wayland x264enc pipeline gives one access unit per frame", async () => {
    const argv = buildWaylandCaptureArgs(1, {
      launch: gstLaunch, pipewiresrc: true, vapostproc: false, vah264enc: false, x264enc: true,
    }, { fps: 30, bitrate: "2M" });
    // The portal's node becomes a test pattern; the caps it negotiates go on PPM's own filter,
    // since gst-launch takes one caps string between two elements.
    argv.splice(argv.indexOf("pipewiresrc"), 2, "videotestsrc", `num-buffers=${FRAMES}`, "pattern=smpte");
    argv[argv.indexOf("video/x-raw")] = "video/x-raw,width=1280,height=720,framerate=30/1,format=BGRx";
    // `videorate` passes the pattern through unchanged except at EOS, where GStreamer 1.28 repeats
    // the last frame (12 buffers in, 13 frames out) and 1.24 does not. The pattern already runs at
    // the capped rate, so a pass-through stands in and the count does not depend on the version.
    argv[argv.indexOf("videorate")] = "identity";
    expectOneUnitPerFrame(await encode(argv));
  });

  /**
   * The pipeline above, recorded, so the slices are checked where no encoder is installed —
   * `Dockerfile.test`'s image has neither ffmpeg nor GStreamer, and skips the three tests above.
   * Made the same way, from `buildWaylandCaptureArgs(1, <x264enc only>, { fps: 30, bitrate: "1M" })`
   * with `videotestsrc num-buffers=12 pattern=ball` at 640x360 for the portal and `identity` for
   * `videorate`: GStreamer 1.28.8, x264 core 165 r3222, a 24-thread host. ffprobe counts 12
   * frames, 1 IDR and 11 P, and x264's own SEI reads `sliced_threads=1 slices=5`.
   */
  it("a recorded x264enc stream gives one access unit per frame", () => {
    const bytes = new Uint8Array(readFileSync(join(import.meta.dir, "../../../fixtures/remote-desktop/x264enc-sliced-640x360.h264")));
    // What the recording is for: every frame is five slices. Counted by NAL type alone, which
    // says nothing about where a picture starts.
    let slices = 0;
    for (let i = 0; i + 3 < bytes.length; i++) {
      if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1 && [1, 5].includes(bytes[i + 3]! & 0x1f)) slices++;
    }
    expect(slices).toBe(12 * 5);
    // The last frame stays pending: only the next one opening proves it is complete.
    expect(new AccessUnitAssembler().push(bytes).length).toBe(12 - 1);
  });
});
