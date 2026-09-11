/**
 * Which displays a remote-desktop session can capture, and where each sits in the host's
 * global coordinate space (input for a non-primary display has to be offset by its origin).
 *
 * macOS: `CGGetActiveDisplayList` order is exactly avfoundation's `Capture screen N` numbering
 * (ffmpeg builds its screen inputs from that same list) — verified: `[1]` 3440×1440 ⇔
 * "Capture screen 1" 3440×1440. Sizes/main flag come from CoreGraphics via bun:ffi; names and
 * bounds go through one JXA call because `CGDisplayBounds` returns a struct by value and
 * `NSScreen.localizedName` is Objective-C — both out of bun:ffi's reach. Cached briefly: the
 * capabilities route polls every 2 s while the checklist is up.
 *
 * Windows: gdigrab `desktop` grabs the whole virtual screen and SendInput maps 0..65535 onto
 * that same rectangle, so there is exactly one "display" and no offsets to apply.
 *
 * X11: monitors come from RandR 1.5 `XRRGetMonitors` through FFI, NOT from parsing `xrandr`.
 * The binary is a separate package from the library and is genuinely absent on hosts that have
 * the library (verified: this dev host has `libXrandr.so.2` and no `xrandr`), so a shell-out
 * reports "no displays" on a working desktop. X11 puts every monitor in one root-window
 * coordinate space — the same model as the Windows virtual desktop — so `x`/`y` are real
 * offsets and a per-monitor capture is a crop of the root window, not a separate device.
 *
 * Wayland: deliberately empty. There is no client-side monitor list to offer — the desktop
 * portal's own dialog is what picks the screen, and its answer arrives as a PipeWire node.
 */

import { detectLinuxSession, type LinuxSession } from "./remote-desktop-linux-session.ts";
import { asPointer, getX11 } from "./remote-desktop-x11.ts";

export interface RemoteDisplay {
  /** Stable per host session (`CGDirectDisplayID` on macOS, `"desktop"` on Windows). */
  id: string;
  label: string;
  primary: boolean;
  /** Origin + size in the OS's global *logical* coordinate space (points on macOS). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Position in the capture backend's own numbering (avfoundation `Capture screen N`). */
  captureIndex: number;
}

const CACHE_MS = 5000;
let cache: { at: number; displays: RemoteDisplay[] } | null = null;

/** `XRRMonitorInfo` on x86-64: `Atom name` (8), `Bool primary` (4), `Bool automatic` (4),
 *  `int noutput` (4), `int x, y, width, height` (16), `int mwidth, mheight` (8), then a
 *  pointer that forces the trailing 4 bytes of padding. Verified against a real 3440x1440
 *  monitor: reading `primary`/`x`/`y`/`width`/`height` at these offsets returns 1/0/0/3440/1440. */
const MONITOR_INFO_SIZE = 56;
const MONITOR_OFF = { name: 0, primary: 8, x: 20, y: 24, width: 28, height: 32 } as const;

async function listX11Displays(session: LinuxSession): Promise<RemoteDisplay[]> {
  const conn = await getX11(session);
  if (!conn) return [];
  const { ffi, x11, xrandr, dpy } = conn;

  /** No libXrandr: one display covering the whole root window, which is what x11grab
   *  captures by default anyway. */
  const wholeScreen = (): RemoteDisplay[] => [{
    id: "screen", label: "Whole screen", primary: true, x: 0, y: 0,
    width: x11.XDisplayWidth(dpy, conn.screen), height: x11.XDisplayHeight(dpy, conn.screen),
    captureIndex: 0,
  }];
  if (!xrandr) return wholeScreen();

  const countOut = new Int32Array(1);
  const monitors = xrandr.XRRGetMonitors(dpy, conn.root, 1, ffi.ptr(countOut));
  const count = countOut[0] ?? 0;
  if (!monitors || count <= 0) return wholeScreen();

  const displays: RemoteDisplay[] = [];
  for (let i = 0; i < count; i++) {
    const base = asPointer(Number(monitors) + i * MONITOR_INFO_SIZE);
    const namePtr = x11.XGetAtomName(dpy, ffi.read.u64(base, MONITOR_OFF.name));
    let label = `Display ${i + 1}`;
    if (namePtr) {
      label = new ffi.CString(namePtr).toString();
      x11.XFree(namePtr);
    }
    displays.push({
      id: label,
      label,
      primary: ffi.read.i32(base, MONITOR_OFF.primary) !== 0,
      x: ffi.read.i32(base, MONITOR_OFF.x),
      y: ffi.read.i32(base, MONITOR_OFF.y),
      width: ffi.read.i32(base, MONITOR_OFF.width),
      height: ffi.read.i32(base, MONITOR_OFF.height),
      captureIndex: i,
    });
  }
  xrandr.XRRFreeMonitors(monitors);
  return displays.length > 0 ? displays : wholeScreen();
}

async function listDarwinDisplays(): Promise<RemoteDisplay[]> {
  const { dlopen, FFIType: T, ptr } = await import("bun:ffi");
  const cg = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", {
    CGGetActiveDisplayList: { args: [T.u32, T.ptr, T.ptr], returns: T.i32 },
    CGDisplayPixelsWide: { args: [T.u32], returns: T.u64 },
    CGDisplayPixelsHigh: { args: [T.u32], returns: T.u64 },
    CGDisplayIsMain: { args: [T.u32], returns: T.bool },
  }).symbols;
  const ids = new Uint32Array(16), count = new Uint32Array(1);
  if (cg.CGGetActiveDisplayList(16, ptr(ids), ptr(count)) !== 0) return [];

  // Names + origins in one osascript round trip (~100 ms); tolerate its absence.
  type Meta = { id: number; name: string; x: number; y: number };
  let meta: Meta[] = [];
  try {
    const proc = Bun.spawnSync(["osascript", "-l", "JavaScript", "-e",
      'ObjC.import("AppKit"); ObjC.import("CoreGraphics"); JSON.stringify($.NSScreen.screens.js.map(s => { ' +
      'const id = s.deviceDescription.objectForKey("NSScreenNumber").unsignedIntValue; const b = $.CGDisplayBounds(id); ' +
      'return { id, name: s.localizedName.js, x: b.origin.x, y: b.origin.y }; }))']);
    meta = JSON.parse(proc.stdout.toString().trim() || "[]");
  } catch { /* names fall back to "Display N", origins to 0 — capture still works */ }

  const displays: RemoteDisplay[] = [];
  const n = count[0] ?? 0;
  for (let i = 0; i < n; i++) {
    const id = ids[i] ?? 0;
    const m = meta.find((x) => x.id === id);
    displays.push({
      id: String(id),
      label: m?.name ?? `Display ${i + 1}`,
      primary: cg.CGDisplayIsMain(id),
      x: m?.x ?? 0,
      y: m?.y ?? 0,
      width: Number(cg.CGDisplayPixelsWide(id)),
      height: Number(cg.CGDisplayPixelsHigh(id)),
      captureIndex: i,
    });
  }
  return displays;
}

/** `linuxSession` is passed explicitly by tests: it otherwise probes the host, and "is there
 *  an X server" is exactly what a headless runner answers differently from a desktop. */
export async function listDisplays(
  platform: NodeJS.Platform = process.platform,
  linuxSession = platform === "linux" ? detectLinuxSession() : null,
): Promise<RemoteDisplay[]> {
  if (platform === "win32") {
    return [{ id: "desktop", label: "All displays", primary: true, x: 0, y: 0, width: 0, height: 0, captureIndex: 0 }];
  }
  if (platform === "linux") {
    // Wayland: the portal dialog picks the screen, so there is nothing to list here.
    if (linuxSession?.kind !== "x11") return [];
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.displays;
    const displays = await listX11Displays(linuxSession);
    cache = { at: Date.now(), displays };
    return displays;
  }
  if (platform !== "darwin") return [];
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.displays;
  const displays = await listDarwinDisplays();
  cache = { at: Date.now(), displays };
  return displays;
}

/** The display a session should capture: the requested one when it still exists (a monitor
 *  can be unplugged between the client's pick and connect), else the primary. */
export async function resolveDisplay(id: string | undefined): Promise<RemoteDisplay | null> {
  const displays = await listDisplays();
  return displays.find((d) => d.id === id) ?? displays.find((d) => d.primary) ?? displays[0] ?? null;
}
