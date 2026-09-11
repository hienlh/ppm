/**
 * One shared Xlib connection for the X11 capture/input paths, over `bun:ffi` — no helper
 * binary, matching `remote-desktop-input-win32.ts` (user32) and `-darwin.ts` (CoreGraphics).
 *
 * Two things here exist to keep a desktop problem from becoming a PPM problem:
 *
 * 1. **Xlib's default I/O error handler calls `exit()`.** If the X server goes away — a
 *    logout, a GPU driver reset, `systemctl restart sddm` — libX11 prints `XIO: fatal IO
 *    error` and terminates the *calling process*, which here is the whole PPM server: every
 *    project, terminal and chat session dies because someone logged out of the desktop. Both
 *    handlers are therefore replaced (`XSetIOErrorHandler` returns instead of falling through,
 *    and libX11 ≥ 1.7's `XSetIOErrorExitHandler` cancels the exit that otherwise happens even
 *    when the first one returns). Protocol errors (`BadWindow` from a monitor unplugged
 *    mid-enumeration) go to a no-op `XSetErrorHandler` rather than the default's stderr spew.
 *    The callbacks are held in module scope: a GC'd `JSCallback` would leave Xlib calling a
 *    freed trampoline, which is a segfault rather than the crash it was installed to prevent.
 *
 * 2. **A connection that took an I/O error is not reusable.** There is no safe call left on it,
 *    not even `XCloseDisplay`, so it is dropped un-closed (a few KB, once per X server
 *    lifetime) and the next caller opens a fresh one.
 *
 * libXtst and libXrandr are optional: a host can have Xlib but no XTEST extension (input goes
 * view-only) or no libXrandr (one whole-screen display instead of per-monitor). Neither is a
 * reason to fail capture, so both load into `null` rather than throwing.
 */
import type { LinuxSession } from "./remote-desktop-linux-session.ts";

type Ffi = typeof import("bun:ffi");
/** Xlib pointer/handle as bun:ffi hands it back. */
type Ptr = number | bigint;

const X11_SYMBOLS = {
  XOpenDisplay: { args: ["cstring"], returns: "ptr" },
  XDefaultRootWindow: { args: ["ptr"], returns: "u64" },
  XDefaultScreen: { args: ["ptr"], returns: "i32" },
  XDisplayWidth: { args: ["ptr", "i32"], returns: "i32" },
  XDisplayHeight: { args: ["ptr", "i32"], returns: "i32" },
  XFlush: { args: ["ptr"], returns: "i32" },
  XSync: { args: ["ptr", "i32"], returns: "i32" },
  XGetAtomName: { args: ["ptr", "u64"], returns: "ptr" },
  XFree: { args: ["ptr"], returns: "i32" },
  XStringToKeysym: { args: ["cstring"], returns: "u64" },
  XKeysymToKeycode: { args: ["ptr", "u64"], returns: "u8" },
  XDisplayKeycodes: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  XGetKeyboardMapping: { args: ["ptr", "u8", "i32", "ptr"], returns: "ptr" },
  XChangeKeyboardMapping: { args: ["ptr", "i32", "i32", "ptr", "i32"], returns: "i32" },
  XQueryPointer: { args: ["ptr", "u64", "ptr", "ptr", "ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  // Privacy mode: an X grab with `owner_events = False` routes every local key and button to
  // the grabbing client, which simply drops them. Paired with `XTestGrabControl` below, which
  // is what keeps the *remote* session's injected events working through that grab.
  XGrabKeyboard: { args: ["ptr", "u64", "i32", "i32", "i32", "u64"], returns: "i32" },
  XGrabPointer: { args: ["ptr", "u64", "i32", "u32", "i32", "i32", "u64", "u64", "u64"], returns: "i32" },
  XUngrabKeyboard: { args: ["ptr", "u64"], returns: "i32" },
  XUngrabPointer: { args: ["ptr", "u64"], returns: "i32" },
  XSetErrorHandler: { args: ["ptr"], returns: "ptr" },
  XSetIOErrorHandler: { args: ["ptr"], returns: "ptr" },
  XSetIOErrorExitHandler: { args: ["ptr", "ptr", "ptr"], returns: "void" },
} as const;

const XTST_SYMBOLS = {
  XTestQueryExtension: { args: ["ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  XTestFakeMotionEvent: { args: ["ptr", "i32", "i32", "i32", "u64"], returns: "i32" },
  XTestFakeButtonEvent: { args: ["ptr", "u32", "i32", "u64"], returns: "i32" },
  XTestFakeKeyEvent: { args: ["ptr", "u32", "i32", "u64"], returns: "i32" },
  /** Makes this client's XTEST events *impervious to grabs* — the one call that lets privacy
   *  mode hold a keyboard/pointer grab without also blocking the remote session's own input. */
  XTestGrabControl: { args: ["ptr", "i32"], returns: "i32" },
} as const;

const XRANDR_SYMBOLS = {
  XRRGetMonitors: { args: ["ptr", "u64", "i32", "ptr"], returns: "ptr" },
  XRRFreeMonitors: { args: ["ptr"], returns: "void" },
  // Resolution switching. `…Current` rather than `XRRGetScreenResources`: the latter re-polls
  // every output over DDC, which takes tens of milliseconds and can wake a sleeping monitor.
  XRRGetScreenResourcesCurrent: { args: ["ptr", "u64"], returns: "ptr" },
  XRRFreeScreenResources: { args: ["ptr"], returns: "void" },
  XRRGetOutputInfo: { args: ["ptr", "ptr", "u64"], returns: "ptr" },
  XRRFreeOutputInfo: { args: ["ptr"], returns: "void" },
  XRRGetCrtcInfo: { args: ["ptr", "ptr", "u64"], returns: "ptr" },
  XRRFreeCrtcInfo: { args: ["ptr"], returns: "void" },
  XRRSetCrtcConfig: {
    args: ["ptr", "ptr", "u64", "u64", "i32", "i32", "u64", "u16", "ptr", "i32"],
    returns: "i32",
  },
  XRRSetScreenSize: { args: ["ptr", "u64", "i32", "i32", "i32", "i32"], returns: "void" },
} as const;

/** DPMS lives in libXext, not libX11. Used to turn the host's monitor off for privacy mode
 *  while leaving the framebuffer — and therefore the capture — alone. */
const DPMS_SYMBOLS = {
  DPMSQueryExtension: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  DPMSCapable: { args: ["ptr"], returns: "i32" },
  DPMSEnable: { args: ["ptr"], returns: "i32" },
  DPMSForceLevel: { args: ["ptr", "u16"], returns: "i32" },
  DPMSInfo: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
} as const;

/* eslint-disable @typescript-eslint/no-explicit-any -- dlopen's symbol types are per-call */
type X11Lib = { [K in keyof typeof X11_SYMBOLS]: any };
type XtstLib = { [K in keyof typeof XTST_SYMBOLS]: any };
type XrandrLib = { [K in keyof typeof XRANDR_SYMBOLS]: any };
type DpmsLib = { [K in keyof typeof DPMS_SYMBOLS]: any };
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface X11Connection {
  ffi: Ffi;
  x11: X11Lib;
  /** null when the host has no libXtst — capture works, input does not. */
  xtst: XtstLib | null;
  /** null when the host has no libXrandr — one whole-screen display instead of per-monitor. */
  xrandr: XrandrLib | null;
  /** null when the host has no libXext, or its X server has no DPMS extension — privacy mode
   *  then blocks local input without blanking the monitor. */
  dpms: DpmsLib | null;
  dpy: Ptr;
  root: bigint;
  screen: number;
  /** XTEST is present AND usable on this connection. */
  hasXTest: boolean;
}

let ffiModule: Ffi | null = null;
let connection: X11Connection | null = null;
/** Kept forever: Xlib holds raw pointers to these trampolines for the process lifetime. */
const liveCallbacks: unknown[] = [];
let handlersInstalled = false;
let connectionLost = false;

function tryDlopen<T>(ffi: Ffi, names: string[], symbols: object): T | null {
  for (const name of names) {
    try { return ffi.dlopen(name, symbols as never).symbols as T; } catch { /* try the next soname */ }
  }
  return null;
}

/** Replace the three handlers that would otherwise print to stderr or kill the process. */
function installErrorHandlers(ffi: Ffi, x11: X11Lib): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  const { JSCallback } = ffi;

  // Protocol error (BadWindow/BadMatch): return 0, the same as the default handler minus stderr.
  const onError = new JSCallback(() => 0, { args: ["ptr", "ptr"], returns: "i32" });
  // I/O error: server gone. Mark dead and return — libX11 would otherwise fall through to exit.
  const onIoError = new JSCallback(() => { connectionLost = true; return 0; }, { args: ["ptr"], returns: "i32" });
  // The exit that happens anyway once the handler above returns. Cancelled by doing nothing.
  const onIoExit = new JSCallback(() => { connectionLost = true; }, { args: ["ptr", "ptr"], returns: "void" });
  liveCallbacks.push(onError, onIoError, onIoExit);

  x11.XSetErrorHandler(onError.ptr);
  x11.XSetIOErrorHandler(onIoError.ptr);
}

/** The shared connection for `session`, or null when Xlib is missing or the server refuses us
 *  (no `$DISPLAY` server running, an auth cookie we cannot read). */
export async function getX11(session: LinuxSession): Promise<X11Connection | null> {
  if (session.kind !== "x11") return null;
  if (connectionLost) { connection = null; connectionLost = false; }
  if (connection) return connection;

  if (!ffiModule) ffiModule = await import("bun:ffi");
  const ffi = ffiModule;
  const x11 = tryDlopen<X11Lib>(ffi, ["libX11.so.6", "libX11.so"], X11_SYMBOLS);
  if (!x11) return null;
  installErrorHandlers(ffi, x11);

  const dpy = x11.XOpenDisplay(Buffer.from(`${session.display}\0`));
  if (!dpy) return null;

  const xtst = tryDlopen<XtstLib>(ffi, ["libXtst.so.6", "libXtst.so"], XTST_SYMBOLS);
  const xrandr = tryDlopen<XrandrLib>(ffi, ["libXrandr.so.2", "libXrandr.so"], XRANDR_SYMBOLS);
  const xext = tryDlopen<DpmsLib>(ffi, ["libXext.so.6", "libXext.so"], DPMS_SYMBOLS);

  let hasXTest = false;
  if (xtst) {
    const out = new Int32Array(1);
    hasXTest = xtst.XTestQueryExtension(dpy, ffi.ptr(out), ffi.ptr(out), ffi.ptr(out), ffi.ptr(out)) !== 0;
  }

  // The exit handler needs the Display, so it is installed after the connection exists.
  const onIoExit = liveCallbacks[2] as { ptr: number } | undefined;
  if (onIoExit) x11.XSetIOErrorExitHandler(dpy, onIoExit.ptr, null);

  // libXext being present is not enough: a server can be built without the DPMS extension, and
  // `DPMSForceLevel` against one of those is a no-op that returns success.
  let dpms: DpmsLib | null = null;
  if (xext) {
    const out = new Int32Array(2);
    const present = xext.DPMSQueryExtension(dpy, ffi.ptr(out), ffi.ptr(out.subarray(1))) !== 0;
    if (present && xext.DPMSCapable(dpy) !== 0) dpms = xext;
  }

  connection = {
    ffi, x11, xtst, xrandr, dpms, dpy,
    root: BigInt(x11.XDefaultRootWindow(dpy)),
    screen: x11.XDefaultScreen(dpy),
    hasXTest,
  };
  return connection;
}

/** `bun:ffi` types every address as a branded `Pointer`, but walking a C array means doing
 *  arithmetic on a plain number. One cast, here, instead of at every struct field. */
export function asPointer(address: number): import("bun:ffi").Pointer {
  return address as unknown as import("bun:ffi").Pointer;
}

/** Drop the cached connection (tests, and after a session change). */
export function resetX11(): void {
  connection = null;
  connectionLost = false;
}
