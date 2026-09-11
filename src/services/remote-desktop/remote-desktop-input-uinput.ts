/**
 * Wayland input backend: two virtual devices on `/dev/uinput`, driven straight from the
 * kernel's evdev interface.
 *
 * Why not XTEST: XTEST is an X server extension. A Wayland compositor is not an X server, and
 * the protocol has no input-injection request at all by design — so the only way in is to be
 * an input *device*. uinput events enter below the compositor, which means they also work on
 * X11 (useful: it is how this backend is testable on an X11 host) and they are indistinguishable
 * from a real keyboard/mouse to everything above.
 *
 * **Two devices, not one.** libinput classifies a device from the capabilities it declares, and
 * a single device advertising both a full keyboard and absolute axes gets misread — typically as
 * a touchpad, which then applies pointer acceleration and treats absolute coordinates as
 * relative motion, so the pointer drifts instead of landing where it was told. A pointer device
 * (absolute axes + buttons + wheel, `INPUT_PROP_DIRECT`) and a keyboard device (keys only) are
 * each unambiguous.
 *
 * **No `text()`.** uinput carries key codes, not characters: there is no counterpart to
 * `KEYEVENTF_UNICODE` (Windows), `CGEventKeyboardSetUnicodeString` (macOS) or even the
 * scratch-keysym remap the X11 backend uses, because the layout that turns a key code into a
 * character lives in the compositor. `text` is therefore absent, the facade's `injectText`
 * returns false, and the client falls back to per-key events. Consequence: a phone soft keyboard
 * that reports no key codes (most Android IMEs) cannot type on a Wayland host.
 *
 * **Absolute coordinates cover the whole desktop.** The kernel knows nothing about monitor
 * layout, so 0..65535 maps to the compositor's full pointer area. Per-monitor targeting is not
 * possible here the way it is under X11's single root-window coordinate space.
 */
import { closeSync, openSync, writeSync } from "node:fs";
import { ALL_EVDEV_CODES, codeToEvdev, MODIFIER_EVDEV_CODES } from "./remote-desktop-evdev-key-map.ts";
import { RemoteInputUnavailableError, type InputTargetRect, type RemoteInputBackend } from "./remote-desktop-input-backend.ts";

/** ioctl request numbers, verified against `linux/uinput.h` on x86-64 rather than derived by
 *  hand: `_IOW` encodes the struct size, so a wrong `sizeof` yields a silently different
 *  request number and `ioctl` fails with EINVAL for no visible reason. */
const UI_DEV_CREATE = 0x5501;
const UI_DEV_DESTROY = 0x5502;
const UI_DEV_SETUP = 0x405c5503;   // _IOW('U', 3, struct uinput_setup)      sizeof 92
const UI_ABS_SETUP = 0x401c5504;   // _IOW('U', 4, struct uinput_abs_setup)  sizeof 28
const UI_SET_EVBIT = 0x40045564;
const UI_SET_KEYBIT = 0x40045565;
const UI_SET_RELBIT = 0x40045566;
const UI_SET_ABSBIT = 0x40045567;
const UI_SET_PROPBIT = 0x4004556e;

const EV_SYN = 0, EV_KEY = 1, EV_REL = 2, EV_ABS = 3;
const SYN_REPORT = 0;
const ABS_X = 0, ABS_Y = 1;
const REL_WHEEL = 8;
const BTN_LEFT = 0x110, BTN_RIGHT = 0x111, BTN_MIDDLE = 0x112;
const INPUT_PROP_DIRECT = 0x01;
const BUS_USB = 0x03;

/** Absolute axis range. Matches Windows `SendInput`'s 0..65535 normalisation, so both
 *  platforms carry the same "fraction of the surface" semantics. */
const ABS_MAX = 65535;
/** `struct input_event` on x86-64: 16-byte timeval (kernel fills it when zero) + u16 type +
 *  u16 code + s32 value. */
const EVENT_SIZE = 24;
/** One notch, matching `WHEEL_DELTA` on the other backends. */
const WHEEL_DELTA = 120;
const MAX_WHEEL_NOTCHES = 64;

type Ffi = typeof import("bun:ffi");
/* eslint-disable @typescript-eslint/no-explicit-any -- dlopen symbol types are per-call */
type Libc = { ioctl: any };
/* eslint-enable @typescript-eslint/no-explicit-any */

interface Devices { pointer: number; keyboard: number }

let ffiModule: Ffi | null = null;
let libc: Libc | null = null;
let devices: Devices | null = null;
let exitHookInstalled = false;

function eventBuf(entries: Array<[type: number, code: number, value: number]>): Uint8Array {
  const buf = new Uint8Array(EVENT_SIZE * entries.length);
  const dv = new DataView(buf.buffer);
  entries.forEach(([type, code, value], i) => {
    const at = i * EVENT_SIZE;
    dv.setUint16(at + 16, type, true);
    dv.setUint16(at + 18, code, true);
    dv.setInt32(at + 20, value, true);
  });
  return buf;
}

/** `struct uinput_setup`: input_id (bustype/vendor/product/version) + char name[80] + u32. */
function setupBuf(name: string, product: number): Uint8Array {
  const buf = new Uint8Array(92);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, BUS_USB, true);
  dv.setUint16(2, 0x1d6b, true);   // Linux Foundation — a virtual device, not a spoofed vendor
  dv.setUint16(4, product, true);
  dv.setUint16(6, 1, true);
  buf.set(new TextEncoder().encode(name).subarray(0, 79), 8);
  return buf;
}

/** `struct uinput_abs_setup`: u16 code + 2 pad + input_absinfo (value/min/max/fuzz/flat/res). */
function absSetupBuf(code: number, max: number): Uint8Array {
  const buf = new Uint8Array(28);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, code, true);
  dv.setInt32(8, 0, true);    // minimum
  dv.setInt32(12, max, true); // maximum
  return buf;
}

async function loadLibc(): Promise<Libc> {
  if (libc) return libc;
  if (!ffiModule) ffiModule = await import("bun:ffi");
  const { dlopen, FFIType } = ffiModule;
  // `ioctl` is variadic in C, but every request here passes one integer/pointer argument, which
  // the x86-64 ABI puts in the same register a fixed third parameter would use.
  libc = dlopen("libc.so.6", {
    ioctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  }).symbols as Libc;
  return libc;
}

function ioctlOrThrow(lib: Libc, fd: number, request: number, arg: number | bigint, what: string): void {
  if (lib.ioctl(fd, BigInt(request), typeof arg === "bigint" ? arg : BigInt(arg)) < 0) {
    throw new RemoteInputUnavailableError(`uinput ${what} failed (is /dev/uinput writable?)`);
  }
}

function createPointerDevice(lib: Libc, ffi: Ffi): number {
  const fd = openSync("/dev/uinput", "w");
  ioctlOrThrow(lib, fd, UI_SET_EVBIT, EV_KEY, "SET_EVBIT EV_KEY");
  for (const btn of [BTN_LEFT, BTN_RIGHT, BTN_MIDDLE]) ioctlOrThrow(lib, fd, UI_SET_KEYBIT, btn, "SET_KEYBIT");
  ioctlOrThrow(lib, fd, UI_SET_EVBIT, EV_REL, "SET_EVBIT EV_REL");
  ioctlOrThrow(lib, fd, UI_SET_RELBIT, REL_WHEEL, "SET_RELBIT");
  ioctlOrThrow(lib, fd, UI_SET_EVBIT, EV_ABS, "SET_EVBIT EV_ABS");
  // `INPUT_PROP_DIRECT` is what stops libinput reading absolute axes as touchpad motion.
  ioctlOrThrow(lib, fd, UI_SET_PROPBIT, INPUT_PROP_DIRECT, "SET_PROPBIT");
  for (const axis of [ABS_X, ABS_Y]) {
    ioctlOrThrow(lib, fd, UI_SET_ABSBIT, axis, "SET_ABSBIT");
    const abs = absSetupBuf(axis, ABS_MAX);
    ioctlOrThrow(lib, fd, UI_ABS_SETUP, BigInt(ffi.ptr(abs)), "ABS_SETUP");
  }
  const setup = setupBuf("PPM Remote Pointer", 0x0001);
  ioctlOrThrow(lib, fd, UI_DEV_SETUP, BigInt(ffi.ptr(setup)), "DEV_SETUP");
  ioctlOrThrow(lib, fd, UI_DEV_CREATE, 0, "DEV_CREATE");
  return fd;
}

function createKeyboardDevice(lib: Libc, ffi: Ffi): number {
  const fd = openSync("/dev/uinput", "w");
  ioctlOrThrow(lib, fd, UI_SET_EVBIT, EV_KEY, "SET_EVBIT EV_KEY");
  for (const code of ALL_EVDEV_CODES) ioctlOrThrow(lib, fd, UI_SET_KEYBIT, code, "SET_KEYBIT");
  const setup = setupBuf("PPM Remote Keyboard", 0x0002);
  ioctlOrThrow(lib, fd, UI_DEV_SETUP, BigInt(ffi.ptr(setup)), "DEV_SETUP");
  ioctlOrThrow(lib, fd, UI_DEV_CREATE, 0, "DEV_CREATE");
  return fd;
}

/** Create both devices once. The compositor needs a moment to notice a new device before the
 *  first event will be routed, so creation is awaited rather than raced with the first click. */
async function ensureDevices(): Promise<Devices> {
  if (devices) return devices;
  if (!ffiModule) ffiModule = await import("bun:ffi");
  const lib = await loadLibc();
  const created = { pointer: createPointerDevice(lib, ffiModule), keyboard: createKeyboardDevice(lib, ffiModule) };
  devices = created;
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // Without DEV_DESTROY the virtual devices outlive the process and pile up in the
    // compositor's device list on every restart.
    process.on("exit", destroyDevices);
  }
  await new Promise<void>((r) => setTimeout(r, 120));
  return created;
}

function destroyDevices(): void {
  if (!devices || !libc) return;
  for (const fd of [devices.pointer, devices.keyboard]) {
    try { libc.ioctl(fd, BigInt(UI_DEV_DESTROY), 0n); } catch { /* going away anyway */ }
    try { closeSync(fd); } catch { /* ditto */ }
  }
  devices = null;
}

function emit(fd: number, entries: Array<[number, number, number]>): void {
  const buf = eventBuf([...entries, [EV_SYN, SYN_REPORT, 0]]);
  writeSync(fd, buf, 0, buf.byteLength);
}

/** `target` is accepted for interface parity but cannot be honoured: the kernel has no monitor
 *  layout, so absolute axes always span the compositor's whole pointer area. */
async function pointer(
  xFrac: number, yFrac: number, button: "left" | "right" | null, down: boolean | null,
  _target: InputTargetRect | null,
): Promise<void> {
  const dev = await ensureDevices();
  const clamp = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
  const events: Array<[number, number, number]> = [
    [EV_ABS, ABS_X, Math.round(clamp(xFrac) * ABS_MAX)],
    [EV_ABS, ABS_Y, Math.round(clamp(yFrac) * ABS_MAX)],
  ];
  if (button && down !== null) events.push([EV_KEY, button === "left" ? BTN_LEFT : BTN_RIGHT, down ? 1 : 0]);
  emit(dev.pointer, events);
}

async function wheel(deltaY: number): Promise<void> {
  const dev = await ensureDevices();
  const notches = Math.round(deltaY / WHEEL_DELTA);
  const clamped = Math.max(-MAX_WHEEL_NOTCHES, Math.min(MAX_WHEEL_NOTCHES, notches));
  if (clamped === 0) return;
  // REL_WHEEL is positive away from the user, the same sign the facade already carries.
  emit(dev.pointer, [[EV_REL, REL_WHEEL, clamped]]);
}

async function key(code: string, down: boolean): Promise<boolean> {
  const evdev = codeToEvdev(code);
  if (evdev === null) return false;
  const dev = await ensureDevices();
  emit(dev.keyboard, [[EV_KEY, evdev, down ? 1 : 0]]);
  return true;
}

async function releaseAllModifiers(): Promise<void> {
  const dev = await ensureDevices();
  emit(dev.keyboard, MODIFIER_EVDEV_CODES.map((c) => [EV_KEY, c, 0] as [number, number, number]));
}

export const uinputInputBackend: RemoteInputBackend = {
  id: "linux-uinput",
  pointer, wheel, key, releaseAllModifiers,
};
