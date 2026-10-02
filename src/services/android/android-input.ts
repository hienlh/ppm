/**
 * Turning viewer gestures into emulator input.
 *
 * The one rule that shapes this file: **`sendKey.text` carries printable ASCII [32,127) and
 * nothing else.** Measured in Phase 0 — `"café"` arrives as `"caf"`, and Vietnamese, emoji and
 * CJK vanish entirely, with no error and no log. So text is split: ASCII goes through `text`,
 * and everything else goes through the clipboard plus a paste combo, which was verified to
 * carry `"Tiếng Việt 😀"` intact into the guest.
 */
import { unaryCall, type EmulatorChannel } from "./android-grpc.ts";
import type { AndroidTouchPoint } from "../../shared/android-protocol.ts";

/** The emulator accepts at most this many simultaneous contacts. */
export const MAX_TOUCH_POINTS = 10;

export function isInjectableAscii(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 32 || code >= 127) return false;
  }
  return true;
}

/**
 * Send one touch update.
 *
 * `pressure: 0` is how a finger is released, and it is mandatory: the proto states an identifier
 * that never sees zero is not unregistered. The emulator does expire a slot on its own, but only
 * after 120 seconds — far too long to rely on, which is why the session has its own release path.
 */
export async function sendTouch(channel: EmulatorChannel, touches: AndroidTouchPoint[]): Promise<void> {
  const clamped = touches.slice(0, MAX_TOUCH_POINTS).map((t) => ({
    x: Math.round(t.x),
    y: Math.round(t.y),
    identifier: Math.max(0, Math.round(t.id)),
    pressure: t.pressure > 0 ? Math.max(1, Math.round(t.pressure)) : 0,
  }));
  await unaryCall(channel, "sendTouch", { touches: clamped }, 2000);
}

/** Release every contact. Called on blur, tab hide, lost control and disconnect. */
export async function releaseAllTouches(channel: EmulatorChannel): Promise<void> {
  const release = Array.from({ length: MAX_TOUCH_POINTS }, (_, i) => ({
    x: 0, y: 0, identifier: i, pressure: 0,
  }));
  await unaryCall(channel, "sendTouch", { touches: release }, 2000);
}

/** The w3c `KeyboardEvent.key` values the emulator maps to Android's own buttons. */
const HARDWARE_KEYS = {
  home: "GoHome",
  back: "GoBack",
  recent: "AppSwitch",
  power: "Power",
  "volume-up": "AudioVolumeUp",
  "volume-down": "AudioVolumeDown",
} as const;

export type HardwareKey = keyof typeof HARDWARE_KEYS;

export async function sendHardwareKey(channel: EmulatorChannel, key: HardwareKey): Promise<void> {
  await unaryCall(channel, "sendKey", { key: HARDWARE_KEYS[key], eventType: "keypress" }, 2000);
}

/** `key` takes the browser's own `KeyboardEvent.key` value — the proto follows the w3c list. */
export async function sendKey(
  channel: EmulatorChannel,
  key: string,
  action: "down" | "up" | "press",
): Promise<void> {
  const eventType = action === "down" ? "keydown" : action === "up" ? "keyup" : "keypress";
  await unaryCall(channel, "sendKey", { key, eventType }, 2000);
}

/** ASCII only — the caller must have checked. Anything else is silently dropped by the emulator. */
export async function sendAsciiText(channel: EmulatorChannel, text: string): Promise<void> {
  // The proto warns the keyboard buffer can be overrun by >1 KB at a time, and points at the
  // clipboard for bulk text. Chunking keeps ordinary typing on this path either way.
  for (let i = 0; i < text.length; i += 256) {
    await unaryCall(channel, "sendKey", { text: text.slice(i, i + 256) }, 3000);
  }
}

/**
 * The path for anything not ASCII: put it on the guest clipboard and paste.
 *
 * Verified end to end in Phase 0 — `setClipboard` carried `"Tiếng Việt 😀"` into the guest
 * exactly, confirmed both by reading it back and by Android's own paste suggestion rendering it.
 */
export async function pasteText(channel: EmulatorChannel, text: string): Promise<void> {
  await unaryCall(channel, "setClipboard", { text }, 3000);
  await unaryCall(channel, "sendKey", { key: "Control", eventType: "keydown" }, 2000);
  await unaryCall(channel, "sendKey", { key: "v", eventType: "keypress" }, 2000);
  await unaryCall(channel, "sendKey", { key: "Control", eventType: "keyup" }, 2000);
}

/** Send text by whichever path can actually carry it. */
export async function sendText(channel: EmulatorChannel, text: string): Promise<"typed" | "pasted"> {
  if (isInjectableAscii(text)) {
    await sendAsciiText(channel, text);
    return "typed";
  }
  await pasteText(channel, text);
  return "pasted";
}

/**
 * Rotate the guest.
 *
 * `setPhysicalModel` with `ROTATION` takes three angles in degrees as [x, y, z], and the proto's
 * own `Rotation.SkinRotation` enum names what each z angle means: PORTRAIT 0, LANDSCAPE 90,
 * REVERSE_PORTRAIT -180, REVERSE_LANDSCAPE -90. So 270 is sent as **-90**, not 270 — the proto
 * documents the angle as being in [-180, 180] and a value outside it has no defined meaning.
 *
 * Nothing here tracks the resulting orientation: every screenshot frame carries the emulator's
 * own `format.rotation`, which is the authority (see `android-video.ts`).
 */
export async function setRotation(channel: EmulatorChannel, degrees: 0 | 90 | 180 | 270): Promise<void> {
  const z = degrees === 270 ? -90 : degrees;
  await unaryCall(channel, "setPhysicalModel", {
    target: "ROTATION",
    value: { data: [0, 0, z] },
  }, 3000);
}

export async function getClipboard(channel: EmulatorChannel): Promise<string> {
  const res = await unaryCall(channel, "getClipboard", {}, 3000);
  return typeof res?.text === "string" ? res.text : "";
}
