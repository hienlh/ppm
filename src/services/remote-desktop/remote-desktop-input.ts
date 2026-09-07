/**
 * Mouse/keyboard injection via Bun FFI straight into `user32.dll` `SendInput` — no separate
 * helper process (drops the Rust-binary build step + unsigned-exe/SmartScreen risk the phase
 * plan flagged for a bundled injector; phase 02's SYSTEM-session helper is a different
 * process/token anyway, so nothing here is meant to be reused as-is).
 *
 * Normal desktop only, current interactive session, no SYSTEM/UAC/lock-screen support.
 *
 * `bun:ffi` is only ever `import()`-ed and `dlopen`-ed lazily from inside `loadUser32()`, so
 * merely importing this module (routing, types) on Linux/macOS test runners never touches
 * `user32.dll`.
 */
import { codeToVk, MODIFIER_VK_CODES } from "./remote-desktop-vk-map.ts";

export class RemoteInputUnavailableError extends Error {
  constructor(msg = "Remote input injection is only available on Windows") {
    super(msg);
    this.name = "RemoteInputUnavailableError";
  }
}

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const MOUSEEVENTF_VIRTUALDESK = 0x4000;
const KEYEVENTF_KEYUP = 0x0002;
/** `((DPI_AWARENESS_CONTEXT)-4)` — PER_MONITOR_AWARE_V2. Not a real pointer; the x64 ABI
 *  passes it in the same register/slot as a pointer arg would, bit pattern only. */
const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4n;
/** Each `INPUT` struct is 40 bytes on x64 (8-byte `type` slot + 32-byte union). */
const INPUT_STRUCT_SIZE = 40;
/** Desktop access rights for input injection. `SendInput` silently no-ops when the calling
 *  thread is not attached to the *input* desktop; attaching needs the READ/WRITE/SWITCH rights
 *  plus JOURNALPLAYBACK so the desktop accepts injected input. These MUST be the real DESKTOP_*
 *  bit values — an invalid mask (e.g. an out-of-range bit) makes `OpenInputDesktop` return NULL
 *  and the attach silently fails, leaving SendInput pointed at the wrong desktop. */
const DESKTOP_READOBJECTS = 0x0001;
const DESKTOP_JOURNALPLAYBACK = 0x0020;
const DESKTOP_WRITEOBJECTS = 0x0080;
const DESKTOP_SWITCHDESKTOP = 0x0100;
const INPUT_DESKTOP_ACCESS =
  DESKTOP_READOBJECTS | DESKTOP_JOURNALPLAYBACK | DESKTOP_WRITEOBJECTS | DESKTOP_SWITCHDESKTOP; // 0x1A1

/** WINSTA_ALL_ACCESS — enough to open the interactive window station and make it this process's
 *  station so its input desktop becomes reachable. */
const WINSTA_ALL_ACCESS = 0x37f;

type FfiModule = typeof import("bun:ffi");
type User32Symbols = {
  SendInput: (count: number, ptr: number | bigint, size: number) => number;
  SetProcessDpiAwarenessContext: (ctx: bigint) => boolean;
  OpenInputDesktop: (flags: number, inherit: boolean, access: number) => number | bigint;
  SetThreadDesktop: (hdesk: number | bigint) => boolean;
  CloseDesktop: (hdesk: number | bigint) => boolean;
  OpenWindowStationW: (name: number | bigint, inherit: boolean, access: number) => number | bigint;
  SetProcessWindowStation: (hwinsta: number | bigint) => boolean;
};

let ffiModule: FfiModule | null = null;
let user32: User32Symbols | null = null;
let dpiAwarenessAttempted = false;

async function loadUser32(): Promise<{ ffi: FfiModule; lib: User32Symbols }> {
  if (process.platform !== "win32") throw new RemoteInputUnavailableError();
  if (!ffiModule) ffiModule = await import("bun:ffi");
  const { dlopen, FFIType } = ffiModule;
  if (!user32) {
    user32 = dlopen("user32.dll", {
      SendInput: { args: [FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.u32 },
      SetProcessDpiAwarenessContext: { args: [FFIType.i64], returns: FFIType.bool },
      OpenInputDesktop: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.ptr },
      SetThreadDesktop: { args: [FFIType.ptr], returns: FFIType.bool },
      CloseDesktop: { args: [FFIType.ptr], returns: FFIType.bool },
      OpenWindowStationW: { args: [FFIType.ptr, FFIType.bool, FFIType.u32], returns: FFIType.ptr },
      SetProcessWindowStation: { args: [FFIType.ptr], returns: FFIType.bool },
    }).symbols as unknown as User32Symbols;
  }
  if (!dpiAwarenessAttempted) {
    dpiAwarenessAttempted = true;
    // A second call to this in the same process returns E_ACCESSDENIED — swallow it, it just
    // means something else (or a previous session) already set it.
    try { user32.SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); } catch { /* already set */ }
  }
  return { ffi: ffiModule, lib: user32 };
}

function writeMouseInput(dv: DataView, offset: number, xAbs: number, yAbs: number, flags: number): void {
  dv.setUint32(offset, INPUT_MOUSE, true);
  dv.setInt32(offset + 8, xAbs, true);
  dv.setInt32(offset + 12, yAbs, true);
  dv.setUint32(offset + 16, 0, true); // mouseData (wheel delta) — unused
  dv.setUint32(offset + 20, flags >>> 0, true);
  dv.setUint32(offset + 24, 0, true); // time: 0 lets the system supply it
}

function writeKeyInput(dv: DataView, offset: number, vk: number, keyUp: boolean): void {
  dv.setUint32(offset, INPUT_KEYBOARD, true);
  dv.setUint16(offset + 8, vk, true);
  dv.setUint16(offset + 10, 0, true); // wScan — unused, we inject by VK not scan code
  dv.setUint32(offset + 12, keyUp ? KEYEVENTF_KEYUP : 0, true);
  dv.setUint32(offset + 16, 0, true); // time
}

/** Handle of the desktop this thread is currently attached to, so we can close the previous one
 *  when the active input desktop changes (lock/unlock/UAC switches it). One handle in flight. */
let attachedDesktop: number | bigint | null = null;

/** Attach the calling thread to the *current* input desktop before injecting. Re-run every send
 *  because the input desktop changes on lock/unlock; `CreateProcessAsUser`/process start only
 *  fixes the initial desktop, not later switches. Best-effort: on failure we still try SendInput
 *  (it just no-ops), and log once rather than per-event spam. */
/** Attach the PROCESS to the interactive window station ("winsta0") once, so its input desktop
 *  is reachable. Without this, a PPM process launched from a non-interactive station (a service,
 *  or some spawners) can't OpenInputDesktop at all — SendInput then goes nowhere. No-op when the
 *  process is already on winsta0 (the normal case for PPM started inside the user's session). */
let stationEnsured = false;
function ensureInteractiveStation(ffi: FfiModule, lib: User32Symbols): void {
  if (stationEnsured) return;
  stationEnsured = true;
  const name = "winsta0";
  const wide = new Uint16Array(name.length + 1);
  for (let i = 0; i < name.length; i++) wide[i] = name.charCodeAt(i);
  const hwinsta = lib.OpenWindowStationW(ffi.ptr(wide), false, WINSTA_ALL_ACCESS);
  if (!hwinsta) return; // already on it, or no access — OpenInputDesktop below will tell us
  lib.SetProcessWindowStation(hwinsta);
}

function attachToInputDesktop(ffi: FfiModule, lib: User32Symbols): void {
  ensureInteractiveStation(ffi, lib);
  const hdesk = lib.OpenInputDesktop(0, false, INPUT_DESKTOP_ACCESS);
  if (!hdesk) return; // couldn't open the input desktop (e.g. secure/lock desktop); leave thread as-is
  const ok = lib.SetThreadDesktop(hdesk);
  if (ok) {
    if (attachedDesktop && attachedDesktop !== hdesk) {
      try { lib.CloseDesktop(attachedDesktop); } catch { /* ignore */ }
    }
    attachedDesktop = hdesk;
  } else {
    // SetThreadDesktop fails if this thread owns windows/hooks — shouldn't for the server thread.
    try { lib.CloseDesktop(hdesk); } catch { /* ignore */ }
  }
}

async function sendRaw(buf: Uint8Array, count: number): Promise<void> {
  const { ffi, lib } = await loadUser32();
  attachToInputDesktop(ffi, lib);
  const sent = lib.SendInput(count, ffi.ptr(buf), INPUT_STRUCT_SIZE);
  if (sent !== count) console.warn(`[remote-desktop] SendInput accepted ${sent}/${count} events`);
}

/** Move the cursor and, if this is a click, press/release the button — one absolute move
 *  per call so the button acts at the position the client actually clicked. `xFrac`/`yFrac`
 *  are 0..1 fractions of the capture (client already dropped devicePixelRatio; only the
 *  canvas-relative fraction is meaningful for host coordinates). */
export async function injectPointer(
  xFrac: number,
  yFrac: number,
  button: "left" | "right" | null,
  down: boolean | null,
): Promise<void> {
  const xAbs = Math.round(Math.min(Math.max(xFrac, 0), 1) * 65535);
  const yAbs = Math.round(Math.min(Math.max(yFrac, 0), 1) * 65535);
  let flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
  if (button === "left") flags |= down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
  else if (button === "right") flags |= down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;

  const buf = new Uint8Array(INPUT_STRUCT_SIZE);
  writeMouseInput(new DataView(buf.buffer), 0, xAbs, yAbs, flags);
  await sendRaw(buf, 1);
}

/** Send a keydown/keyup by physical key code. Returns false for an unmapped code (caller
 *  should just drop it rather than injecting a wrong key). */
export async function injectKey(code: string, down: boolean): Promise<boolean> {
  const vk = codeToVk(code);
  if (vk === null) return false;
  const buf = new Uint8Array(INPUT_STRUCT_SIZE);
  writeKeyInput(new DataView(buf.buffer), 0, vk, !down);
  await sendRaw(buf, 1);
  return true;
}

/** Force keyup for every modifier VK, regardless of tracked state — the backstop for a lost
 *  keyup (blur, WS drop) leaving Shift/Ctrl/Alt/Win logically held on the host. */
export async function releaseAllModifiers(): Promise<void> {
  if (process.platform !== "win32") return;
  const buf = new Uint8Array(INPUT_STRUCT_SIZE * MODIFIER_VK_CODES.length);
  const dv = new DataView(buf.buffer);
  MODIFIER_VK_CODES.forEach((vk, i) => writeKeyInput(dv, i * INPUT_STRUCT_SIZE, vk, true));
  try { await sendRaw(buf, MODIFIER_VK_CODES.length); } catch { /* best-effort */ }
}

export function isInputAvailable(): boolean {
  return process.platform === "win32";
}
