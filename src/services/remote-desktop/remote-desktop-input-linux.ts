/**
 * X11 input backend: `bun:ffi` into libXtst's XTEST extension — no helper process, matching
 * `remote-desktop-input-win32.ts` (user32/SendInput) and `-darwin.ts` (CoreGraphics).
 *
 * Selected by `remote-desktop-input.ts` on `linux`, and it answers only for an X11 session:
 * XTEST is an X server extension, so a Wayland compositor has nothing to inject into and this
 * backend reports unavailable there (`remote-desktop-input-uinput.ts` covers that case).
 *
 * Keys go through `remote-desktop-evdev-key-map.ts` + `X11_KEYCODE_OFFSET`, never through
 * `XKeysymToKeycode` — see that file for why a keysym lookup transposes a non-US keyboard.
 *
 * Text is harder than on the other two platforms: X11 has no "type this Unicode string" call
 * (`KEYEVENTF_UNICODE` / `CGEventKeyboardSetUnicodeString` have no counterpart). So `text()`
 * has two paths:
 *  - **Fast path** — the character already exists in the active keymap, which covers all ASCII
 *    on any ordinary layout. Press its real keycode, with Shift when it sits in the shifted
 *    slot. No mapping change, no round trip per character.
 *  - **Slow path** — anything else (`ệ`, `日`, an emoji). A scratch keycode with no keysyms of
 *    its own is temporarily bound to the character's Unicode keysym, pressed, and unbound
 *    again. This needs a real delay after the remap, not just `XSync`: the server applies the
 *    change immediately but the focused *client* only learns about it when it processes the
 *    `MappingNotify`, and a key pressed before then is interpreted with the old mapping.
 *
 * Caveat shared with macOS/Windows: injected keys enter the host's input stack *above* its
 * IME, so a Telex/ibus input method running on the host will still rewrite what arrives
 * (typing "World" through a Telex IME lands as "ửold"). That is the host's IME doing its job,
 * not a bug here.
 */
import { asPointer, getX11, type X11Connection } from "./remote-desktop-x11.ts";
import { detectLinuxSession, type LinuxSession } from "./remote-desktop-linux-session.ts";
import { codeToEvdev, MODIFIER_EVDEV_CODES, X11_KEYCODE_OFFSET } from "./remote-desktop-evdev-key-map.ts";
import { RemoteInputUnavailableError, type InputTargetRect, type RemoteInputBackend } from "./remote-desktop-input-backend.ts";

/** X core protocol button numbers. 4/5 are the wheel's two directions — X11 has no scroll
 *  axis, a notch *is* a button click. */
const BUTTON_LEFT = 1;
const BUTTON_RIGHT = 3;
const BUTTON_WHEEL_UP = 4;
const BUTTON_WHEEL_DOWN = 5;
/** One notch, matching `WHEEL_DELTA` on Windows — the client sends in these units. */
const WHEEL_DELTA = 120;
/** Above this a runaway client value is clamped rather than turned into thousands of clicks. */
const MAX_WHEEL_NOTCHES = 64;
/** ShiftLeft, for reaching the shifted half of the keymap in `text()`. */
const SHIFT_KEYCODE = 42 + X11_KEYCODE_OFFSET;
/** How long a client needs to process the `MappingNotify` from a scratch-keycode remap before
 *  a key pressed on it is read with the new mapping. `xdotool type` uses 12ms for the same
 *  reason; below ~8ms characters start arriving as the previous mapping on a busy host. */
const REMAP_SETTLE_MS = 12;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The X11 keysym for a Unicode code point. Latin-1 is its own keysym range; everything else
 *  uses the `0x01000000 | codepoint` convention every X server understands. */
function unicodeKeysym(cp: number): number {
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) ? cp : 0x01000000 | cp;
}

async function connect(): Promise<X11Connection> {
  const session: LinuxSession | null = detectLinuxSession();
  if (session?.kind !== "x11") {
    throw new RemoteInputUnavailableError("remote input needs an X11 session (Wayland uses uinput)");
  }
  const conn = await getX11(session);
  if (!conn?.xtst || !conn.hasXTest) {
    throw new RemoteInputUnavailableError("the X server has no XTEST extension (install libXtst)");
  }
  return conn;
}

/** Where a 0..1 fraction lands in root-window coordinates. X11 puts every monitor in one root
 *  coordinate space, so a per-monitor target is just an offset rect inside it. */
function toRootCoords(
  conn: X11Connection, xFrac: number, yFrac: number, target: InputTargetRect | null,
): { x: number; y: number } {
  const rect = target ?? {
    x: 0, y: 0,
    width: conn.x11.XDisplayWidth(conn.dpy, conn.screen),
    height: conn.x11.XDisplayHeight(conn.dpy, conn.screen),
  };
  const clamp = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
  return {
    x: Math.round(rect.x + clamp(xFrac) * Math.max(0, rect.width - 1)),
    y: Math.round(rect.y + clamp(yFrac) * Math.max(0, rect.height - 1)),
  };
}

async function pointer(
  xFrac: number, yFrac: number, button: "left" | "right" | null, down: boolean | null,
  target: InputTargetRect | null,
): Promise<void> {
  const conn = await connect();
  const { x, y } = toRootCoords(conn, xFrac, yFrac, target);
  conn.xtst!.XTestFakeMotionEvent(conn.dpy, conn.screen, x, y, 0);
  if (button && down !== null) {
    conn.xtst!.XTestFakeButtonEvent(conn.dpy, button === "left" ? BUTTON_LEFT : BUTTON_RIGHT, down ? 1 : 0, 0);
  }
  conn.x11.XFlush(conn.dpy);
}

/** `deltaY` in 120-unit notches, positive = away from the user (scroll up), matching the
 *  Windows/macOS backends. X11 turns each notch into a press+release of button 4 or 5. */
async function wheel(deltaY: number): Promise<void> {
  const conn = await connect();
  const notches = Math.min(MAX_WHEEL_NOTCHES, Math.round(Math.abs(deltaY) / WHEEL_DELTA));
  if (notches === 0) return;
  const button = deltaY > 0 ? BUTTON_WHEEL_UP : BUTTON_WHEEL_DOWN;
  for (let i = 0; i < notches; i++) {
    conn.xtst!.XTestFakeButtonEvent(conn.dpy, button, 1, 0);
    conn.xtst!.XTestFakeButtonEvent(conn.dpy, button, 0, 0);
  }
  conn.x11.XFlush(conn.dpy);
}

async function key(code: string, down: boolean): Promise<boolean> {
  const evdev = codeToEvdev(code);
  if (evdev === null) return false;
  const conn = await connect();
  conn.xtst!.XTestFakeKeyEvent(conn.dpy, evdev + X11_KEYCODE_OFFSET, down ? 1 : 0, 0);
  conn.x11.XFlush(conn.dpy);
  return true;
}

/** keysym → the keycode that produces it and whether Shift is needed. Rebuilt per `text()`
 *  call rather than cached: a layout switch would otherwise leave a stale index pressing
 *  keycodes that now produce different characters, which is worse than one round trip. */
function buildKeysymIndex(conn: X11Connection): Map<number, { keycode: number; shift: boolean }> {
  const { ffi, x11, dpy } = conn;
  const index = new Map<number, { keycode: number; shift: boolean }>();
  const min = new Int32Array(1), max = new Int32Array(1);
  x11.XDisplayKeycodes(dpy, ffi.ptr(min), ffi.ptr(max));
  const count = max[0]! - min[0]! + 1;
  if (count <= 0) return index;

  const perCode = new Int32Array(1);
  const syms = x11.XGetKeyboardMapping(dpy, min[0]!, count, ffi.ptr(perCode));
  if (!syms) return index;
  const base = asPointer(Number(syms));
  // Only the first two slots: they are the plain and Shift levels. Level 3/4 need AltGr, so a
  // character living only there is left to the scratch-keycode path instead of guessing.
  const slots = Math.min(2, perCode[0]!);
  for (let i = 0; i < count; i++) {
    for (let slot = 0; slot < slots; slot++) {
      const keysym = Number(ffi.read.u64(base, (i * perCode[0]! + slot) * 8));
      if (keysym !== 0 && !index.has(keysym)) {
        index.set(keysym, { keycode: min[0]! + i, shift: slot === 1 });
      }
    }
  }
  x11.XFree(syms);
  return index;
}

/** A keycode with no keysyms of its own, safe to borrow for one character. null when the
 *  keymap is full (then non-ASCII text is dropped rather than clobbering a real key). */
function findScratchKeycode(conn: X11Connection): number | null {
  const { ffi, x11, dpy } = conn;
  const min = new Int32Array(1), max = new Int32Array(1);
  x11.XDisplayKeycodes(dpy, ffi.ptr(min), ffi.ptr(max));
  const count = max[0]! - min[0]! + 1;
  if (count <= 0) return null;
  const perCode = new Int32Array(1);
  const syms = x11.XGetKeyboardMapping(dpy, min[0]!, count, ffi.ptr(perCode));
  if (!syms) return null;
  const base = asPointer(Number(syms));
  let found: number | null = null;
  // Search from the top: high keycodes are where a layout is least likely to grow into.
  for (let i = count - 1; i >= 0 && found === null; i--) {
    let empty = true;
    for (let slot = 0; slot < perCode[0]!; slot++) {
      if (Number(ffi.read.u64(base, (i * perCode[0]! + slot) * 8)) !== 0) { empty = false; break; }
    }
    if (empty) found = min[0]! + i;
  }
  x11.XFree(syms);
  return found;
}

async function text(str: string): Promise<void> {
  const conn = await connect();
  const { ffi, x11, xtst, dpy } = conn;
  const index = buildKeysymIndex(conn);
  let scratch: number | null | undefined;
  const scratchSyms = new BigUint64Array(1);

  const tap = (keycode: number, shift: boolean) => {
    if (shift) xtst!.XTestFakeKeyEvent(dpy, SHIFT_KEYCODE, 1, 0);
    xtst!.XTestFakeKeyEvent(dpy, keycode, 1, 0);
    xtst!.XTestFakeKeyEvent(dpy, keycode, 0, 0);
    if (shift) xtst!.XTestFakeKeyEvent(dpy, SHIFT_KEYCODE, 0, 0);
    x11.XFlush(dpy);
  };

  try {
    for (const ch of str) {
      const cp = ch.codePointAt(0);
      if (cp === undefined) continue;
      const hit = index.get(unicodeKeysym(cp));
      if (hit) { tap(hit.keycode, hit.shift); continue; }

      if (scratch === undefined) scratch = findScratchKeycode(conn);
      if (scratch === null) continue; // no borrowable keycode — drop rather than clobber a real key
      scratchSyms[0] = BigInt(unicodeKeysym(cp));
      x11.XChangeKeyboardMapping(dpy, scratch, 1, ffi.ptr(scratchSyms), 1);
      x11.XSync(dpy, 0);
      await sleep(REMAP_SETTLE_MS);
      tap(scratch, false);
      await sleep(REMAP_SETTLE_MS);
    }
  } finally {
    // Always hand the scratch keycode back, including after a throw mid-string: leaving a
    // Unicode keysym bound to it would make that key type a stray character forever.
    if (typeof scratch === "number") {
      scratchSyms[0] = 0n;
      x11.XChangeKeyboardMapping(dpy, scratch, 1, ffi.ptr(scratchSyms), 1);
      x11.XSync(dpy, 0);
    }
  }
}

async function releaseAllModifiers(): Promise<void> {
  const conn = await connect();
  for (const evdev of MODIFIER_EVDEV_CODES) {
    conn.xtst!.XTestFakeKeyEvent(conn.dpy, evdev + X11_KEYCODE_OFFSET, 0, 0);
  }
  conn.x11.XFlush(conn.dpy);
}

export const x11InputBackend: RemoteInputBackend = {
  id: "linux-xtest",
  pointer, wheel, key, text, releaseAllModifiers,
};
