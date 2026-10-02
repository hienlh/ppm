/** Windows monitor rectangles in physical pixels, matching gdigrab and SendInput's virtual
 * desktop. Keep FFI lazy so importing the display router on Linux/macOS is harmless. */
import type { RemoteDisplay } from "./remote-desktop-displays.ts";

const MONITOR_INFO_EX_SIZE = 104; // MONITORINFO (40 bytes) + WCHAR szDevice[32]
const PER_MONITOR_AWARE_V2 = -4n;

function openUser32() {
  const ffi = require("bun:ffi") as typeof import("bun:ffi");
  const { FFIType: T } = ffi;
  const library = ffi.dlopen("user32.dll", {
    GetSystemMetrics: { args: [T.i32], returns: T.i32 },
    EnumDisplayMonitors: { args: [T.ptr, T.ptr, T.ptr, T.i64], returns: T.i32 },
    GetMonitorInfoW: { args: [T.ptr, T.ptr], returns: T.i32 },
    SetThreadDpiAwarenessContext: { args: [T.i64], returns: T.i64 },
  });
  return { ffi, library, symbols: library.symbols };
}

let user32: ReturnType<typeof openUser32> | null | undefined;
function loadUser32() {
  if (user32 === undefined) {
    try { user32 = process.platform === "win32" ? openUser32() : null; }
    catch { user32 = null; }
  }
  return user32;
}

/** Thread-scoped awareness works even if an earlier dependency set the process DPI mode.
 * Do not await inside this scope: restore before returning control to Bun's event loop. */
function physicalPixels<T>(api: NonNullable<ReturnType<typeof loadUser32>>, read: () => T): T {
  const previous = api.symbols.SetThreadDpiAwarenessContext(PER_MONITOR_AWARE_V2);
  try { return read(); }
  finally { if (previous) api.symbols.SetThreadDpiAwarenessContext(previous); }
}

/** Decode MONITORINFOEXW, including signed origins for monitors left/above the primary. */
export function decodeWindowsMonitorInfo(info: Uint8Array): RemoteDisplay | null {
  if (info.byteLength < MONITOR_INFO_EX_SIZE) return null;
  const view = new DataView(info.buffer, info.byteOffset, info.byteLength);
  const x = view.getInt32(4, true), y = view.getInt32(8, true);
  const width = view.getInt32(12, true) - x, height = view.getInt32(16, true) - y;
  let device = "";
  for (let offset = 40; offset < MONITOR_INFO_EX_SIZE; offset += 2) {
    const unit = view.getUint16(offset, true);
    if (unit === 0) break;
    device += String.fromCharCode(unit);
  }
  if (!device || width <= 0 || height <= 0) return null;
  return {
    id: device,
    label: device.replace(/^\\\\\.\\DISPLAY/i, "Display "),
    primary: (view.getUint32(36, true) & 1) !== 0,
    x, y, width, height, captureIndex: 0,
  };
}

export function windowsVirtualScreen(): { x: number; y: number; width: number; height: number } {
  const api = loadUser32();
  if (!api) return { x: 0, y: 0, width: 0, height: 0 };
  return physicalPixels(api, () => ({
    x: api.symbols.GetSystemMetrics(76),
    y: api.symbols.GetSystemMetrics(77),
    width: api.symbols.GetSystemMetrics(78),
    height: api.symbols.GetSystemMetrics(79),
  }));
}

export function listWindowsDisplays(): RemoteDisplay[] {
  const api = loadUser32();
  const monitors: RemoteDisplay[] = [];
  if (api) {
    physicalPixels(api, () => {
      const callback = new api.ffi.JSCallback((monitor) => {
        const info = new Uint8Array(MONITOR_INFO_EX_SIZE);
        new DataView(info.buffer).setUint32(0, MONITOR_INFO_EX_SIZE, true);
        if (api.symbols.GetMonitorInfoW(monitor, api.ffi.ptr(info))) {
          const display = decodeWindowsMonitorInfo(info);
          if (display && !monitors.some((entry) => entry.id === display.id)) monitors.push(display);
        }
        return 1;
      }, { args: ["ptr", "ptr", "ptr", "i64"], returns: "i32" });
      try {
        if (!api.symbols.EnumDisplayMonitors(null, null, callback.ptr, 0)) monitors.length = 0;
      } finally { callback.close(); }
    });
  }
  // Device names survive enumeration-order changes; HMONITOR handles and list indices don't.
  monitors.sort((a, b) => Number(b.primary) - Number(a.primary) || a.id.localeCompare(b.id, "en", { numeric: true }));
  monitors.forEach((display, index) => { display.captureIndex = index; });
  return [...monitors, {
    id: "desktop", label: "All displays", primary: monitors.length === 0,
    ...windowsVirtualScreen(), captureIndex: 0,
  }];
}
