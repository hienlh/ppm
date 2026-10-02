/** Run with Bun inside an interactive Windows session and an isolated PPM_HOME.
 * Captures two frames per surface without saving images; moves (never clicks) the
 * cursor to verify selected-monitor input, then restores its physical position. */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { listDisplays } from "../../src/services/remote-desktop/remote-desktop-displays.ts";
import { buildCaptureArgs } from "../../src/services/remote-desktop/remote-desktop-capture.ts";
import { captureInputForPlatform } from "../../src/services/remote-desktop/remote-desktop-capture-input.ts";
import { findFfmpegBinary } from "../../src/services/media-transcode/ffmpeg-capabilities.ts";
import { injectPointer } from "../../src/services/remote-desktop/remote-desktop-input.ts";

if (process.platform !== "win32" || !process.env.PPM_HOME) throw new Error("Requires Windows and isolated PPM_HOME");
const user32 = dlopen("user32.dll", {
  GetPhysicalCursorPos: { args: [FFIType.ptr], returns: FFIType.bool },
  SetPhysicalCursorPos: { args: [FFIType.i32, FFIType.i32], returns: FFIType.bool },
});
const cursor = () => {
  const point = new Int32Array(2);
  if (!user32.symbols.GetPhysicalCursorPos(ptr(point))) throw new Error("Cannot read physical cursor");
  return { x: point[0]!, y: point[1]! };
};
const saved = cursor();
try {
  const displays = await listDisplays();
  const ffmpeg = findFfmpegBinary("ffmpeg");
  if (!ffmpeg) throw new Error("FFmpeg missing");
  if (displays.length < 2) throw new Error("Expected at least two monitors for this e2e");
  for (const display of displays) {
    const input = captureInputForPlatform("win32", display.captureIndex, { rect: display })!;
    const args = buildCaptureArgs(ffmpeg, "libx264", input, { fps: 5, bitrate: "2M" });
    args.splice(args.length - 3, 0, "-frames:v", "2");
    const child = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 15000);
    const [output, error, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
    clearTimeout(timer);
    if (code !== 0 || output.byteLength === 0) throw new Error(`${display.id} capture failed: ${code} ${error}`);
    for (const [xf, yf] of [[0.25, 0.25], [0.5, 0.5], [0.75, 0.75]]) {
      await injectPointer(xf!, yf!, null, null, display);
      await Bun.sleep(100);
      const actual = cursor();
      const expected = { x: display.x + Math.round(xf! * (display.width - 1)), y: display.y + Math.round(yf! * (display.height - 1)) };
      if (Math.abs(actual.x - expected.x) > 2 || Math.abs(actual.y - expected.y) > 2) {
        throw new Error(`${display.id} cursor mismatch: ${JSON.stringify({actual, expected})}`);
      }
    }
    console.log(JSON.stringify({ id: display.id, width: display.width, height: display.height, x: display.x, y: display.y, encodedBytes: output.byteLength, pointer: "passed" }));
  }
} finally {
  user32.symbols.SetPhysicalCursorPos(saved.x, saved.y);
  user32.close();
}
