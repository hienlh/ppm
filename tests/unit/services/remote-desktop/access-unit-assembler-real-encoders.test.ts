import { describe, expect, it } from "bun:test";
import { AccessUnitAssembler, type AccessUnit } from "../../../../src/services/remote-desktop/access-unit-assembler.ts";
import { buildWaylandCaptureArgs } from "../../../../src/services/remote-desktop/remote-desktop-capture-wayland.ts";
import { captureEncoderArgs } from "../../../../src/services/remote-desktop/remote-desktop-encoder-args.ts";
import { encoderArgs as androidEncoderArgs } from "../../../../src/services/android/android-video.ts";

/**
 * The encoders PPM really drives, through the assembler, with a test pattern in place of the
 * screen or the phone. x264 under `tune=zerolatency` cuts a frame into one slice per thread, and
 * the assembler used to send every slice as a frame of its own: a Wayland host showed a solid
 * green picture (#48), Chrome decoded nothing. A fixture of hand-made NALs cannot catch that —
 * it encodes the same assumption the assembler does — so this asks the encoders themselves.
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

/** Slices that open a picture (first_mb_in_slice = 0), counted straight from Annex-B bytes. */
function picturesIn(bytes: Uint8Array): number {
  let n = 0;
  for (let i = 0; i + 4 < bytes.length; i++) {
    if (bytes[i] !== 0 || bytes[i + 1] !== 0 || bytes[i + 2] !== 1) continue;
    const type = bytes[i + 3]! & 0x1f;
    if ((type === 1 || type === 5) && (bytes[i + 4]! & 0x80)) n++;
  }
  return n;
}

async function encode(argv: string[]): Promise<{ aus: AccessUnit[]; pictures: number }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const stdout = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  expect(await proc.exited).toBe(0);
  return { aus: new AccessUnitAssembler().push(stdout), pictures: picturesIn(stdout) };
}

function expectOnePicturePerUnit({ aus, pictures }: { aus: AccessUnit[]; pictures: number }): void {
  expect(pictures).toBeGreaterThan(1);
  // The last picture stays pending: only the next one opening proves it is complete.
  expect(aus.length).toBe(pictures - 1);
  for (const au of aus) expect(picturesIn(au.bytes)).toBe(1);
}

const lavfi = (size: string) => [
  ffmpeg!, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=30`, "-frames:v", String(FRAMES),
];

describe("real encoders through AccessUnitAssembler", () => {
  it.skipIf(!libx264)("X11 capture's libx264 gives one access unit per frame", async () => {
    expectOnePicturePerUnit(await encode([
      ...lavfi("1280x720"), ...captureEncoderArgs("libx264", { fps: 30, bitrate: "2M" }), "-f", "h264", "pipe:1",
    ]));
  });

  it.skipIf(!libx264)("the Android viewer's libx264 fallback gives one access unit per frame", async () => {
    // Everything after the input is the viewer's own encode; only the source is swapped.
    const args = androidEncoderArgs({ encoder: "libx264", width: 720, height: 1280, fps: 30, bitrate: "2M" });
    expectOnePicturePerUnit(await encode([...lavfi("720x1280"), ...args.slice(args.indexOf("pipe:0") + 1)]));
  });

  it.skipIf(!gstHas("x264enc"))("the Wayland x264enc pipeline gives one access unit per frame", async () => {
    const argv = buildWaylandCaptureArgs(1, {
      launch: gstLaunch, pipewiresrc: true, vapostproc: false, vah264enc: false, x264enc: true,
    }, { fps: 30, bitrate: "2M" });
    // The portal's node becomes a test pattern; the caps it negotiates go on PPM's own filter,
    // since gst-launch takes one caps string between two elements.
    argv.splice(argv.indexOf("pipewiresrc"), 2, "videotestsrc", `num-buffers=${FRAMES}`, "pattern=smpte");
    argv[argv.indexOf("video/x-raw")] = "video/x-raw,width=1280,height=720,framerate=30/1,format=BGRx";
    expectOnePicturePerUnit(await encode(argv));
  });
});
