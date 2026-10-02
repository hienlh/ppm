/**
 * A still of the device screen, and the clipboard both ways.
 *
 * Deliberately **PNG** rather than the raw RGBA the video pipeline consumes: the emulator encodes
 * it itself, so nothing here has to know the buffer layout — and that layout is exactly what the
 * proto's own comment gets wrong (it says "bottom up"; measured against `adb exec-out screencap`
 * it is top-down, see the Phase 0 report §5.3). A file the user downloads is not the place to
 * rediscover that.
 *
 * `getScreenshot` is a *unary* call, so it is independent of the session's `streamScreenshot` —
 * measured in Phase 2: 343 frames before, 358 after, i.e. taking a still does not disturb a
 * running stream.
 */
import { unaryCall, type EmulatorChannel } from "./android-grpc.ts";

export interface Screenshot {
  png: Uint8Array;
  width: number;
  height: number;
}

/**
 * `width`/`height` in `ImageFormat` are a **bounding box** that preserves the device's aspect
 * ratio, not an exact size (Phase 0 §5.4). Omitting them is what asks for the native resolution,
 * which is what a screenshot should be.
 */
export async function takeScreenshot(channel: EmulatorChannel, timeoutMs = 10_000): Promise<Screenshot> {
  const img = await unaryCall<any>(channel, "getScreenshot", { format: "PNG" }, timeoutMs);
  const png: Uint8Array = img?.image instanceof Uint8Array ? img.image : new Uint8Array(img?.image ?? []);
  if (png.length === 0) throw new Error("the emulator returned an empty screenshot");
  return {
    png,
    // `format.width/height` is the authority; the top-level pair is deprecated in the proto.
    width: Number(img?.format?.width ?? img?.width ?? 0),
    height: Number(img?.format?.height ?? img?.height ?? 0),
  };
}

/** A filename a person can find again: the AVD, then the local date and time. */
export function screenshotFilename(avdName: string, at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  const safe = avdName.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "device";
  return `${safe}-${stamp}.png`;
}

/** Longer than this and it is not a clipboard, it is a file transfer. */
export const MAX_CLIPBOARD_CHARS = 64 * 1024;

export async function setDeviceClipboard(channel: EmulatorChannel, text: string): Promise<void> {
  if (text.length > MAX_CLIPBOARD_CHARS) throw new Error("clipboard text is too long");
  await unaryCall(channel, "setClipboard", { text }, 3000);
}
