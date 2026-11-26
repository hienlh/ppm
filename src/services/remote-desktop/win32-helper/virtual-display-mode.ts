/**
 * Gives the virtual display a usable size once it is on.
 *
 * Measured on a headless Windows 11 host: the driver's modes are 800x600, 1366x768, 1920x1080,
 * 2560x1440 and 3840x2160, and Windows picks the first one — the session came up at 800x600@30.
 * Changing a display mode is an ordinary user call (`ChangeDisplaySettingsExW`), so PPM does it
 * itself right after the SYSTEM task enables the device; `CDS_UPDATEREGISTRY` makes Windows keep
 * it for the next time the device is enabled.
 *
 * `bun:ffi` is required lazily and only on win32.
 */
import { createLogger } from "../../logger.ts";

const log = createLogger("remote-desktop");

export interface DisplayMode { width: number; height: number; refresh: number }

export const TARGET_MODE = { width: 1920, height: 1080 } as const;

/** 1920x1080 at the highest refresh up to 60 Hz; else the largest mode no wider than that. */
export function chooseVirtualDisplayMode(modes: DisplayMode[]): DisplayMode | null {
  const exact = modes
    .filter((m) => m.width === TARGET_MODE.width && m.height === TARGET_MODE.height && m.refresh <= 60)
    .sort((a, b) => b.refresh - a.refresh)[0];
  if (exact) return exact;
  return modes
    .filter((m) => m.width <= TARGET_MODE.width && m.height <= TARGET_MODE.height)
    .sort((a, b) => b.width * b.height - a.width * a.height || b.refresh - a.refresh)[0] ?? null;
}

/** The adapter description the driver registers (`DeviceString` of its display device). */
const VDD_ADAPTER = /virtual display driver/i;

const DISPLAY_DEVICE_SIZE = 840; // cb + DeviceName[32] + DeviceString[128] + StateFlags + DeviceID[128] + DeviceKey[128]
const DEVMODE_SIZE = 220;
const DM = { size: 68, fields: 72, width: 172, height: 176, frequency: 184 } as const;
const DM_PELSWIDTH = 0x80000, DM_PELSHEIGHT = 0x100000, DM_DISPLAYFREQUENCY = 0x400000;
const DISPLAY_DEVICE_ATTACHED_TO_DESKTOP = 0x1;
const ENUM_CURRENT_SETTINGS = -1;
const CDS_UPDATEREGISTRY = 0x1;

function wide(text: string): Uint16Array {
  const out = new Uint16Array(text.length + 1);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

function readWide(view: DataView, offset: number, chars: number): string {
  let s = "";
  for (let i = 0; i < chars; i++) {
    const c = view.getUint16(offset + i * 2, true);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** Find the virtual display's device and set its mode. Best effort: logs and returns false. */
export function applyVirtualDisplayMode(): boolean {
  if (process.platform !== "win32") return false;
  try {
    const ffi = require("bun:ffi") as typeof import("bun:ffi");
    const { FFIType: T } = ffi;
    const user32 = ffi.dlopen("user32.dll", {
      EnumDisplayDevicesW: { args: [T.ptr, T.u32, T.ptr, T.u32], returns: T.i32 },
      EnumDisplaySettingsW: { args: [T.ptr, T.i32, T.ptr], returns: T.i32 },
      ChangeDisplaySettingsExW: { args: [T.ptr, T.ptr, T.ptr, T.u32, T.ptr], returns: T.i32 },
    }).symbols;

    let device: string | null = null;
    for (let i = 0; i < 32 && !device; i++) {
      const dd = new Uint8Array(DISPLAY_DEVICE_SIZE);
      const view = new DataView(dd.buffer);
      view.setUint32(0, DISPLAY_DEVICE_SIZE, true);
      if (!user32.EnumDisplayDevicesW(null, i, ffi.ptr(dd), 0)) break;
      const flags = view.getUint32(324, true);
      if ((flags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP) && VDD_ADAPTER.test(readWide(view, 68, 128))) {
        device = readWide(view, 4, 32);
      }
    }
    if (!device) { log.warn("virtual display mode: no attached Virtual Display Driver device"); return false; }
    const name = wide(device);

    const modes: DisplayMode[] = [];
    for (let m = 0; m < 1000; m++) {
      const dm = new Uint8Array(DEVMODE_SIZE);
      const view = new DataView(dm.buffer);
      view.setUint16(DM.size, DEVMODE_SIZE, true);
      if (!user32.EnumDisplaySettingsW(ffi.ptr(name), m, ffi.ptr(dm))) break;
      modes.push({ width: view.getUint32(DM.width, true), height: view.getUint32(DM.height, true), refresh: view.getUint32(DM.frequency, true) });
    }
    const target = chooseVirtualDisplayMode(modes);
    if (!target) { log.warn(`virtual display mode: nothing suitable among ${modes.length} modes`); return false; }

    const dm = new Uint8Array(DEVMODE_SIZE);
    const view = new DataView(dm.buffer);
    view.setUint16(DM.size, DEVMODE_SIZE, true);
    user32.EnumDisplaySettingsW(ffi.ptr(name), ENUM_CURRENT_SETTINGS, ffi.ptr(dm));
    if (view.getUint32(DM.width, true) === target.width && view.getUint32(DM.height, true) === target.height) return true;
    view.setUint32(DM.width, target.width, true);
    view.setUint32(DM.height, target.height, true);
    view.setUint32(DM.frequency, target.refresh, true);
    view.setUint32(DM.fields, DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY, true);
    const result = user32.ChangeDisplaySettingsExW(ffi.ptr(name), ffi.ptr(dm), null, CDS_UPDATEREGISTRY, null);
    log.info(`virtual display mode ${device} -> ${target.width}x${target.height}@${target.refresh}: result=${result}`);
    return result === 0;
  } catch (e) {
    log.warn(`virtual display mode failed: ${(e as Error).message}`);
    return false;
  }
}
