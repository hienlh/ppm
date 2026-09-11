/**
 * Lists and switches the *host's* real display mode — RustDesk's `_ResolutionsMenu`.
 *
 * Over FFI rather than by shelling out to `xrandr`, for the reason already documented for the
 * monitor list: `xrandr` the binary and `libXrandr` the library are different packages, and
 * this dev host has the library and not the binary. A version that shells out reports "no
 * resolutions" on a perfectly good desktop.
 *
 * Struct offsets are x86-64 and are written out rather than derived, because a wrong one does
 * not fail — it reads a neighbouring field, so a mode list comes back with plausible-looking
 * garbage in it. They are checked against an independent oracle in the test: the kernel's own
 * the `modes` file under `/sys/class/drm/<card>-<connector>`, which lists what the attached display advertises.
 *
 *   XRRScreenResources (64):  timestamp 0, configTimestamp 8, ncrtc 16, crtcs 24,
 *                             noutput 32, outputs 40, nmode 48, modes 56
 *   XRRModeInfo (80):         id 0, width 8, height 12, dotClock 16, hTotal 32, vTotal 48,
 *                             name 56, nameLength 64, modeFlags 72
 *   XRROutputInfo (96):       crtc 8, name 16, nameLen 24, mm_width 32, mm_height 40,
 *                             connection 48, ncrtc 52, crtcs 56, nmode 80, npreferred 84,
 *                             modes 88
 *   XRRCrtcInfo (64):         x 8, y 12, width 16, height 20, mode 24, rotation 32,
 *                             noutput 36, outputs 40
 *
 * Switching is not one call but a *sequence*, because the root window is a container for the
 * CRTCs and neither may be outside the other. A CRTC cannot be configured past the screen
 * bounds, so any dimension that grows needs `XRRSetScreenSize` **first**; and a screen smaller
 * than a still-active CRTC is equally invalid, so trimming it down has to come **last**. A
 * switch where one dimension grows and the other shrinks (1920x1200 → 2560x1080) needs both,
 * which is why `planResolutionSwitch` is a pure function with its own test rather than a pair
 * of branches — getting it wrong leaves the mode applied and the root window the wrong size,
 * i.e. a desktop with a dead strip down one side, which no error reports.
 */
import { detectLinuxSession } from "./remote-desktop-linux-session.ts";
import { asPointer, getX11, type X11Connection } from "./remote-desktop-x11.ts";

/** `RR_Connected` from `randr.h`. */
const RR_CONNECTED = 0;
const RR_ROTATE_0 = 1;
const CURRENT_TIME = 0n;
/** `RRSetConfigSuccess`. */
const SET_CONFIG_SUCCESS = 0;
/** `RR_Interlace` / `RR_DoubleScan` in `modeFlags`, which change what the timings mean. */
const RR_INTERLACE = 0x10;
const RR_DOUBLE_SCAN = 0x20;

const SIZEOF_MODE_INFO = 80;

export interface HostMode {
  /** `RRMode` XID, the value a switch is requested by. Stringified because it is a 64-bit id
   *  and it travels over JSON. */
  id: string;
  width: number;
  height: number;
  /** Vertical refresh, one decimal place. 0 when the timings do not allow computing one. */
  refresh: number;
  /** True for the mode the output is on right now. */
  current: boolean;
  /** True for the display's preferred (native) mode. */
  preferred: boolean;
}

export interface HostResolutions {
  /** Connector name (`HDMI-2`, `DP-1`), or null when nothing usable was found. */
  output: string | null;
  modes: HostMode[];
  /** Why the list is empty, or null. */
  reason: string | null;
}

/** dotClock / (hTotal * vTotal), corrected for interlace and doublescan the way `xrandr` does. */
export function modeRefresh(dotClock: number, hTotal: number, vTotal: number, flags: number): number {
  if (hTotal <= 0 || vTotal <= 0 || dotClock <= 0) return 0;
  let vTotalAdjusted = vTotal;
  if (flags & RR_DOUBLE_SCAN) vTotalAdjusted *= 2;
  if (flags & RR_INTERLACE) vTotalAdjusted /= 2;
  return Math.round((dotClock / (hTotal * vTotalAdjusted)) * 10) / 10;
}

interface Resources {
  res: number;
  view: DataView;
  modes: Map<string, { width: number; height: number; refresh: number }>;
}

function readResources(x: X11Connection): Resources | null {
  const res = x.xrandr!.XRRGetScreenResourcesCurrent(x.dpy, x.root);
  if (!res) return null;
  const header = new DataView(x.ffi.toArrayBuffer(asPointer(Number(res)), 0, 64));
  const nmode = header.getInt32(48, true);
  const modesPtr = Number(header.getBigUint64(56, true));
  const modes = new Map<string, { width: number; height: number; refresh: number }>();
  if (modesPtr && nmode > 0) {
    const table = new DataView(x.ffi.toArrayBuffer(asPointer(modesPtr), 0, nmode * SIZEOF_MODE_INFO));
    for (let i = 0; i < nmode; i++) {
      const at = i * SIZEOF_MODE_INFO;
      modes.set(String(table.getBigUint64(at, true)), {
        width: table.getUint32(at + 8, true),
        height: table.getUint32(at + 12, true),
        refresh: modeRefresh(
          Number(table.getBigUint64(at + 16, true)),
          table.getUint32(at + 32, true),
          table.getUint32(at + 48, true),
          Number(table.getBigUint64(at + 72, true)),
        ),
      });
    }
  }
  return { res: Number(res), view: header, modes };
}

/** The first connected output that has a CRTC, plus its info pointer. Multi-head hosts get the
 *  one the session is actually driving; PPM streams one display at a time anyway. */
function firstActiveOutput(x: X11Connection, r: Resources): { output: number; info: number } | null {
  const noutput = r.view.getInt32(32, true);
  const outputsPtr = Number(r.view.getBigUint64(40, true));
  if (!outputsPtr || noutput <= 0) return null;
  const ids = new DataView(x.ffi.toArrayBuffer(asPointer(outputsPtr), 0, noutput * 8));
  for (let i = 0; i < noutput; i++) {
    const id = ids.getBigUint64(i * 8, true);
    const info = Number(x.xrandr!.XRRGetOutputInfo(x.dpy, asPointer(r.res), id));
    if (!info) continue;
    const iv = new DataView(x.ffi.toArrayBuffer(asPointer(info), 0, 96));
    const connected = iv.getUint16(48, true) === RR_CONNECTED;
    const crtc = iv.getBigUint64(8, true);
    if (connected && crtc !== 0n) return { output: Number(id), info };
    x.xrandr!.XRRFreeOutputInfo(asPointer(info));
  }
  return null;
}

function outputName(x: X11Connection, info: number): string {
  const iv = new DataView(x.ffi.toArrayBuffer(asPointer(info), 0, 96));
  const ptr = Number(iv.getBigUint64(16, true));
  const len = iv.getInt32(24, true);
  if (!ptr || len <= 0) return "";
  return new TextDecoder().decode(new Uint8Array(x.ffi.toArrayBuffer(asPointer(ptr), 0, len)));
}

/** Every mode the host's active output supports. */
export async function listHostResolutions(
  platform: NodeJS.Platform = process.platform,
): Promise<HostResolutions> {
  if (platform !== "linux") {
    return { output: null, modes: [], reason: "Only implemented on Linux (X11) so far." };
  }
  const session = detectLinuxSession();
  if (session?.kind !== "x11") {
    return { output: null, modes: [], reason: "Changing the host resolution needs an X11 session." };
  }
  const x = await getX11(session);
  if (!x?.xrandr) {
    return { output: null, modes: [], reason: "The host has no libXrandr." };
  }
  const r = readResources(x);
  if (!r) return { output: null, modes: [], reason: "The X server returned no screen resources." };
  try {
    const active = firstActiveOutput(x, r);
    if (!active) return { output: null, modes: [], reason: "No connected output with a CRTC." };
    try {
      const iv = new DataView(x.ffi.toArrayBuffer(asPointer(active.info), 0, 96));
      const crtc = iv.getBigUint64(8, true);
      const nmode = iv.getInt32(80, true);
      const npreferred = iv.getInt32(84, true);
      const modesPtr = Number(iv.getBigUint64(88, true));

      // Which mode is live right now comes from the CRTC, not the output.
      let currentMode = "0";
      const crtcInfo = Number(x.xrandr.XRRGetCrtcInfo(x.dpy, asPointer(r.res), crtc));
      if (crtcInfo) {
        const cv = new DataView(x.ffi.toArrayBuffer(asPointer(crtcInfo), 0, 64));
        currentMode = String(cv.getBigUint64(24, true));
        x.xrandr.XRRFreeCrtcInfo(asPointer(crtcInfo));
      }

      const modes: HostMode[] = [];
      if (modesPtr && nmode > 0) {
        const ids = new DataView(x.ffi.toArrayBuffer(asPointer(modesPtr), 0, nmode * 8));
        for (let i = 0; i < nmode; i++) {
          const id = String(ids.getBigUint64(i * 8, true));
          const info = r.modes.get(id);
          if (!info || info.width === 0 || info.height === 0) continue;
          modes.push({
            id,
            width: info.width,
            height: info.height,
            refresh: info.refresh,
            current: id === currentMode,
            // `npreferred` is a *count* of preferred modes at the head of the list, not an
            // index — reading it as an index marks the wrong mode native.
            preferred: i < npreferred,
          });
        }
      }
      return { output: outputName(x, active.info) || null, modes, reason: null };
    } finally {
      x.xrandr.XRRFreeOutputInfo(asPointer(active.info));
    }
  } finally {
    x.xrandr.XRRFreeScreenResources(asPointer(r.res));
  }
}

export interface ResolutionSwitchPlan {
  /** The mode is already live; make no X calls at all. */
  noop: boolean;
  /** Screen size to set *before* reconfiguring the CRTC, or null when nothing grows. */
  grow: { width: number; height: number } | null;
  /** Screen size to set *after*. A no-op when `grow` already hit these numbers. */
  final: { width: number; height: number };
}

/** The order of `XRRSetScreenSize`/`XRRSetCrtcConfig` calls for one switch. See the header. */
export function planResolutionSwitch(
  oldWidth: number, oldHeight: number, newWidth: number, newHeight: number,
): ResolutionSwitchPlan {
  const final = { width: newWidth, height: newHeight };
  if (oldWidth === newWidth && oldHeight === newHeight) return { noop: true, grow: null, final };
  const grows = newWidth > oldWidth || newHeight > oldHeight;
  return {
    noop: false,
    // Per dimension, not per switch: the shrinking half of a mixed switch still may not clip
    // the CRTC while it is live, so both dimensions hold their maximum across the reconfigure
    // and `final` trims whichever one overshot.
    grow: grows ? { width: Math.max(oldWidth, newWidth), height: Math.max(oldHeight, newHeight) } : null,
    final,
  };
}

export interface SetResolutionResult {
  ok: boolean;
  /** The mode that is live afterwards, whether or not the switch was the one asked for. */
  width: number;
  height: number;
  error: string | null;
}

/**
 * Put the host's active output on `modeId`. Returns what is actually live afterwards.
 */
export async function setHostResolution(
  modeId: string, platform: NodeJS.Platform = process.platform,
): Promise<SetResolutionResult> {
  const fail = (error: string): SetResolutionResult => ({ ok: false, width: 0, height: 0, error });
  if (platform !== "linux") return fail("Only implemented on Linux (X11) so far.");
  const session = detectLinuxSession();
  if (session?.kind !== "x11") return fail("Needs an X11 session.");
  const x = await getX11(session);
  if (!x?.xrandr) return fail("The host has no libXrandr.");
  const r = readResources(x);
  if (!r) return fail("The X server returned no screen resources.");
  try {
    const target = r.modes.get(modeId);
    if (!target) return fail("That mode is not one this host advertises.");
    const active = firstActiveOutput(x, r);
    if (!active) return fail("No connected output with a CRTC.");
    try {
      const iv = new DataView(x.ffi.toArrayBuffer(asPointer(active.info), 0, 96));
      const crtc = iv.getBigUint64(8, true);
      const mmWidth = Number(iv.getBigUint64(32, true));
      const mmHeight = Number(iv.getBigUint64(40, true));

      const crtcInfo = Number(x.xrandr.XRRGetCrtcInfo(x.dpy, asPointer(r.res), crtc));
      if (!crtcInfo) return fail("Could not read the CRTC.");
      const cv = new DataView(x.ffi.toArrayBuffer(asPointer(crtcInfo), 0, 64));
      const cx = cv.getInt32(8, true);
      const cy = cv.getInt32(12, true);
      const oldWidth = cv.getUint32(16, true);
      const oldHeight = cv.getUint32(20, true);
      x.xrandr.XRRFreeCrtcInfo(asPointer(crtcInfo));

      const plan = planResolutionSwitch(oldWidth, oldHeight, target.width, target.height);
      if (plan.noop) return { ok: true, width: oldWidth, height: oldHeight, error: null };

      const setScreen = (width: number, height: number) => {
        // The millimetres are the output's real ones, so the desktop's DPI does not move with
        // the mode. Passing the conventional 96dpi figure instead makes every font on the host
        // change size when a remote user picks a resolution.
        x.xrandr!.XRRSetScreenSize(x.dpy, x.root, width, height, mmWidth, mmHeight);
        x.x11.XSync(x.dpy, 0);
      };

      if (plan.grow) setScreen(plan.grow.width, plan.grow.height);
      const outputs = new BigUint64Array([BigInt(active.output)]);
      const status = x.xrandr.XRRSetCrtcConfig(
        x.dpy, asPointer(r.res), crtc, CURRENT_TIME, cx, cy,
        BigInt(modeId), RR_ROTATE_0, x.ffi.ptr(outputs), 1,
      );
      x.x11.XSync(x.dpy, 0);
      if (status !== SET_CONFIG_SUCCESS) {
        // Put the container back, or the desktop keeps a dead strip the CRTC never filled.
        if (plan.grow) setScreen(oldWidth, oldHeight);
        return fail(`The X server refused the mode (status ${status}).`);
      }
      setScreen(plan.final.width, plan.final.height);
      return { ok: true, width: target.width, height: target.height, error: null };
    } finally {
      x.xrandr.XRRFreeOutputInfo(asPointer(active.info));
    }
  } finally {
    x.xrandr.XRRFreeScreenResources(asPointer(r.res));
  }
}
