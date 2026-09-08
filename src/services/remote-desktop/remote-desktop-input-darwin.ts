/**
 * macOS input backend: Bun FFI straight into CoreGraphics (`CGEventPost` at the HID tap) — no
 * helper binary, no signing question for the injector. Selected by `remote-desktop-input.ts`
 * on `darwin` only; `bun:ffi` is `import()`-ed and `dlopen`-ed lazily inside `load()` so
 * importing this module elsewhere never touches a framework.
 *
 * Spike facts this relies on (`plans/reports/spike-260908-remote-desktop-macos.md` §S2):
 * - `CGPoint` is passed BY VALUE as two consecutive `double` args — matches the arm64 (d0,d1)
 *   and x86_64 (xmm0,xmm1) ABIs, integer args keep their own registers. Struct *returns* are
 *   not expressible, so nothing here reads the cursor back.
 * - Injection needs the Accessibility grant on the `bun` executable (TCC); without it every
 *   post is a silent no-op — `availability()` reports that via `AXIsProcessTrusted`.
 * - Coordinates are logical points of the main display (`CGDisplayPixelsWide/High` return
 *   points despite the name); the capture is that same display, so fractions map directly.
 * - Modifier state is carried on every event as `CGEventFlags`; a modifier keyDown alone is
 *   not enough, so held modifiers are tracked and OR-ed onto each subsequent event.
 */
import { codeToCgKey, CGKEY_MODIFIER_FLAG, MODIFIER_CGKEY_CODES } from "./remote-desktop-cg-key-map.ts";
import { RemoteInputUnavailableError, type RemoteInputBackend } from "./remote-desktop-input-backend.ts";

const CG = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
const APP_SERVICES = "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices";
const CORE_FOUNDATION = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";

// CGEventType
const LEFT_DOWN = 1, LEFT_UP = 2, RIGHT_DOWN = 3, RIGHT_UP = 4, MOUSE_MOVED = 5;
const LEFT_DRAGGED = 6, RIGHT_DRAGGED = 7, KEY_DOWN = 10, KEY_UP = 11, FLAGS_CHANGED = 12;
const HID_EVENT_TAP = 0;
const BUTTON_LEFT = 0, BUTTON_RIGHT = 1;
const SCROLL_UNIT_LINE = 1;
/** kCGMouseEventClickState — must be set on synthesized clicks or apps never see a double-click. */
const FIELD_CLICK_STATE = 1;
const DOUBLE_CLICK_MS = 500;
/** One wheel notch (the client's 120-unit) scrolls this many lines, as it does on Windows. */
const LINES_PER_NOTCH = 3;

type Ptr = number | bigint;
type Symbols = {
  CGEventCreateMouseEvent: (src: Ptr | null, type: number, x: number, y: number, button: number) => Ptr;
  CGEventCreateKeyboardEvent: (src: Ptr | null, keycode: number, down: boolean) => Ptr;
  CGEventCreateScrollWheelEvent2: (src: Ptr | null, units: number, count: number, w1: number, w2: number, w3: number) => Ptr;
  CGEventSetFlags: (ev: Ptr, flags: bigint) => void;
  CGEventSetType: (ev: Ptr, type: number) => void;
  CGEventSetIntegerValueField: (ev: Ptr, field: number, value: bigint) => void;
  CGEventKeyboardSetUnicodeString: (ev: Ptr, length: bigint, utf16: Ptr) => void;
  CGEventPost: (tap: number, ev: Ptr) => void;
  CGMainDisplayID: () => number;
  CGDisplayPixelsWide: (display: number) => bigint;
  CGDisplayPixelsHigh: (display: number) => bigint;
  AXIsProcessTrusted: () => boolean;
  CFRelease: (obj: Ptr) => void;
};

let loaded: { ffi: typeof import("bun:ffi"); lib: Symbols } | null = null;

async function load() {
  if (process.platform !== "darwin") throw new RemoteInputUnavailableError();
  if (loaded) return loaded;
  const ffi = await import("bun:ffi");
  const { dlopen, FFIType: T } = ffi;
  const cg = dlopen(CG, {
    CGEventCreateMouseEvent: { args: [T.ptr, T.u32, T.double, T.double, T.u32], returns: T.ptr },
    CGEventCreateKeyboardEvent: { args: [T.ptr, T.u16, T.bool], returns: T.ptr },
    CGEventCreateScrollWheelEvent2: { args: [T.ptr, T.u32, T.u32, T.i32, T.i32, T.i32], returns: T.ptr },
    CGEventSetFlags: { args: [T.ptr, T.u64], returns: T.void },
    CGEventSetType: { args: [T.ptr, T.u32], returns: T.void },
    CGEventSetIntegerValueField: { args: [T.ptr, T.u32, T.i64], returns: T.void },
    CGEventKeyboardSetUnicodeString: { args: [T.ptr, T.u64, T.ptr], returns: T.void },
    CGEventPost: { args: [T.u32, T.ptr], returns: T.void },
    CGMainDisplayID: { args: [], returns: T.u32 },
    CGDisplayPixelsWide: { args: [T.u32], returns: T.u64 },
    CGDisplayPixelsHigh: { args: [T.u32], returns: T.u64 },
  }).symbols;
  const ax = dlopen(APP_SERVICES, { AXIsProcessTrusted: { args: [], returns: T.bool } }).symbols;
  const cf = dlopen(CORE_FOUNDATION, { CFRelease: { args: [T.ptr], returns: T.void } }).symbols;
  loaded = { ffi, lib: { ...cg, ...ax, ...cf } as unknown as Symbols };
  return loaded;
}

// Per-process injection state. One remote-desktop session at a time drives the real desktop,
// so module-level state is the right scope (same as the win32 backend's desktop handle).
let heldButton: "left" | "right" | null = null;
const heldModifiers = new Set<number>();
let lastDownAt = 0;
let lastDownX = -1, lastDownY = -1, clickState = 1;

function modifierFlags(): bigint {
  let flags = 0;
  for (const code of heldModifiers) flags |= CGKEY_MODIFIER_FLAG[code] ?? 0;
  return BigInt(flags);
}

function post(lib: Symbols, ev: Ptr, type?: number): void {
  if (type !== undefined) lib.CGEventSetType(ev, type);
  lib.CGEventSetFlags(ev, modifierFlags());
  lib.CGEventPost(HID_EVENT_TAP, ev);
  lib.CFRelease(ev);
}

/** Fraction → logical point on the main display, clamped so a wild client value stays on screen. */
function toPoint(lib: Symbols, xFrac: number, yFrac: number): { x: number; y: number } {
  const display = lib.CGMainDisplayID();
  const w = Number(lib.CGDisplayPixelsWide(display)), h = Number(lib.CGDisplayPixelsHigh(display));
  return { x: Math.min(Math.max(xFrac, 0), 1) * w, y: Math.min(Math.max(yFrac, 0), 1) * h };
}

async function pointer(xFrac: number, yFrac: number, button: "left" | "right" | null, down: boolean | null): Promise<void> {
  const { lib } = await load();
  const { x, y } = toPoint(lib, xFrac, yFrac);
  if (button === null || down === null) {
    // Pure move: a drag while a button is held, else a plain move.
    const type = heldButton === "left" ? LEFT_DRAGGED : heldButton === "right" ? RIGHT_DRAGGED : MOUSE_MOVED;
    post(lib, lib.CGEventCreateMouseEvent(null, type, x, y, heldButton === "right" ? BUTTON_RIGHT : BUTTON_LEFT));
    return;
  }
  const cgButton = button === "left" ? BUTTON_LEFT : BUTTON_RIGHT;
  const type = button === "left" ? (down ? LEFT_DOWN : LEFT_UP) : (down ? RIGHT_DOWN : RIGHT_UP);
  if (down) {
    const now = Date.now();
    const samePlace = Math.abs(x - lastDownX) < 4 && Math.abs(y - lastDownY) < 4;
    clickState = now - lastDownAt < DOUBLE_CLICK_MS && samePlace ? clickState + 1 : 1;
    lastDownAt = now; lastDownX = x; lastDownY = y;
    heldButton = button;
  } else {
    heldButton = null;
  }
  const ev = lib.CGEventCreateMouseEvent(null, type, x, y, cgButton);
  lib.CGEventSetIntegerValueField(ev, FIELD_CLICK_STATE, BigInt(clickState));
  post(lib, ev);
}

async function wheel(deltaY: number): Promise<void> {
  const { lib } = await load();
  const lines = Math.max(-32768, Math.min(32767, Math.round((deltaY / 120) * LINES_PER_NOTCH)));
  if (lines === 0) return;
  post(lib, lib.CGEventCreateScrollWheelEvent2(null, SCROLL_UNIT_LINE, 1, lines, 0, 0));
}

async function key(code: string, down: boolean): Promise<boolean> {
  const keycode = codeToCgKey(code);
  if (keycode === null) return false;
  const { lib } = await load();
  const isModifier = keycode in CGKEY_MODIFIER_FLAG;
  if (isModifier) { if (down) heldModifiers.add(keycode); else heldModifiers.delete(keycode); }
  // Modifier keys travel as FlagsChanged (with the new flag state already applied above), never
  // as KeyDown/KeyUp — apps ignore a KeyDown for Shift but honour the flags on it.
  post(lib, lib.CGEventCreateKeyboardEvent(null, keycode, down), isModifier ? FLAGS_CHANGED : undefined);
  return true;
}

/** Carrier keycode for Unicode text events. The attached string is what a Cocoa text view
 *  types, but the keycode still matters to anything hooking events by key:
 *  - `0` (kVK_ANSI_A, what most tools use) is re-read as a literal "a" by third-party IMEs
 *    (OpenKey/EVKey Telex turned "日本" into "â" — two keycode-0 events = "aa" → "â");
 *  - function keys (F13–F19) and unassigned codes (0x7F, 0xFF) produce NO text at all;
 *  - Space passes through IMEs as a word break and types every tested char, incl. `\t`, `\n`,
 *    CJK and surrogate-pair emoji.
 *  Text is still subject to the host's active IME (Telex rewrote "World" → "ửold"); that is
 *  inherent to injection on any OS, not something the carrier can avoid. */
const TEXT_CARRIER_KEYCODE = 0x31;

/** Type text as Unicode, one code point per keyDown/keyUp pair. */
async function text(str: string): Promise<void> {
  const { ffi, lib } = await load();
  for (const ch of str) {
    const utf16 = new Uint16Array(ch.length);
    for (let i = 0; i < ch.length; i++) utf16[i] = ch.charCodeAt(i);
    for (const down of [true, false]) {
      const ev = lib.CGEventCreateKeyboardEvent(null, TEXT_CARRIER_KEYCODE, down);
      lib.CGEventKeyboardSetUnicodeString(ev, BigInt(utf16.length), ffi.ptr(utf16));
      post(lib, ev);
    }
  }
}

async function releaseAllModifiers(): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    const { lib } = await load();
    heldModifiers.clear();
    for (const keycode of MODIFIER_CGKEY_CODES) post(lib, lib.CGEventCreateKeyboardEvent(null, keycode, false), FLAGS_CHANGED);
    if (heldButton) {
      // A button still down on disconnect would leave the host mid-drag; release it in place.
      const type = heldButton === "left" ? LEFT_UP : RIGHT_UP;
      post(lib, lib.CGEventCreateMouseEvent(null, type, lastDownX, lastDownY, heldButton === "left" ? BUTTON_LEFT : BUTTON_RIGHT));
      heldButton = null;
    }
  } catch { /* best-effort */ }
}

export const darwinInputBackend: RemoteInputBackend = {
  id: "darwin-cgevent",
  availability: async () => {
    const { lib } = await load();
    return lib.AXIsProcessTrusted()
      ? { available: true }
      : { available: false, reason: "Grant Accessibility to the PPM process (System Settings → Privacy & Security → Accessibility)" };
  },
  pointer, wheel, key, text, releaseAllModifiers,
};
