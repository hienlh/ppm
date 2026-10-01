/**
 * The macOS half of the host-resolution menu — CoreGraphics over `bun:ffi`, the counterpart to
 * the XRandR code in `remote-desktop-resolution.ts`.
 *
 * It is far less work than X11: there is no root-window container to keep in step with the
 * CRTC, so no `planResolutionSwitch` equivalent and no ordering trap. `CGDisplaySetDisplayMode`
 * is one call and the window server resizes the desktop itself.
 *
 * Two things *are* traps, and the first one is the reason this file cannot just list modes.
 *
 * **The mode the display is on is usually not in the mode list.** Measured on this M-series
 * host: `CGDisplayCopyDisplayMode` answers IODisplayModeID **54** (1728x1117 points backed by
 * 3456x2234 pixels — an ordinary Retina scaled mode), while `CGDisplayCopyAllDisplayModes`
 * returns 60 modes numbered 60–131, every one of them 1:1 with `width === pixelWidth`. Passing
 * `kCGDisplayShowDuplicateLowResolutionModes` changes nothing — still 60, still no HiDPI entry,
 * still not the current one. So a menu built from the list alone has **nothing ticked** on a
 * stock Retina Mac, which is exactly the failure the XRandR side documents for a host sitting
 * on a timing the menu collapsed away. The live mode is therefore added as a synthetic row.
 *
 * It also has to be **retained**, which is the second trap. A mode absent from the list cannot
 * be looked up again, so "put it back the way you found it" — the one setting here that
 * outlives the session on the host's own screen — would fail with the Mac left in a non-Retina
 * mode for good. `seen` keeps the owned `CGDisplayModeRef` for every mode this process has
 * observed as current, so a restore always has something to pass to `CGDisplaySetDisplayMode`.
 *
 * Note what switching means here, because it is not what it means on Linux: every listed mode
 * is 1:1, so picking one takes the Mac **out of Retina**. That is the right trade for the
 * feature's purpose (a client gets a 1:1 picture instead of a scaled one) and it is reversible,
 * but it is a visible change on the host's own panel rather than a neutral one.
 *
 * Every CoreGraphics reference crosses FFI as `u64` and never `T.ptr` — see the tagged-pointer
 * note in CLAUDE.md. A `CGDisplayModeRef` is a heap object today, but `T.ptr` returns a JS
 * double and would silently round any reference above 2^53.
 */
import type { HostMode, HostResolutions, SetResolutionResult } from "./remote-desktop-resolution.ts";

const CG = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
const CORE_FOUNDATION = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";

/** `kCGErrorSuccess`. */
const CG_ERROR_SUCCESS = 0;

type Symbols = {
  CGMainDisplayID: () => number;
  CGDisplayCopyAllDisplayModes: (display: number, options: bigint) => bigint;
  CGDisplayCopyDisplayMode: (display: number) => bigint;
  CGDisplaySetDisplayMode: (display: number, mode: bigint, options: bigint) => number;
  CGDisplayModeGetWidth: (mode: bigint) => bigint;
  CGDisplayModeGetHeight: (mode: bigint) => bigint;
  CGDisplayModeGetPixelWidth: (mode: bigint) => bigint;
  CGDisplayModeGetPixelHeight: (mode: bigint) => bigint;
  CGDisplayModeGetRefreshRate: (mode: bigint) => number;
  CGDisplayModeGetIODisplayModeID: (mode: bigint) => number;
  CGDisplayModeIsUsableForDesktopGUI: (mode: bigint) => boolean;
  CGDisplayModeRelease: (mode: bigint) => void;
  CFArrayGetCount: (array: bigint) => bigint;
  CFArrayGetValueAtIndex: (array: bigint, index: bigint) => bigint;
  CFRelease: (obj: bigint) => void;
};

let loaded: Symbols | null = null;

async function load(): Promise<Symbols | null> {
  if (process.platform !== "darwin") return null;
  if (loaded) return loaded;
  try {
    const { dlopen, FFIType: T } = await import("bun:ffi");
    const cg = dlopen(CG, {
      CGMainDisplayID: { args: [], returns: T.u32 },
      CGDisplayCopyAllDisplayModes: { args: [T.u32, T.u64], returns: T.u64 },
      CGDisplayCopyDisplayMode: { args: [T.u32], returns: T.u64 },
      CGDisplaySetDisplayMode: { args: [T.u32, T.u64, T.u64], returns: T.i32 },
      CGDisplayModeGetWidth: { args: [T.u64], returns: T.u64 },
      CGDisplayModeGetHeight: { args: [T.u64], returns: T.u64 },
      CGDisplayModeGetPixelWidth: { args: [T.u64], returns: T.u64 },
      CGDisplayModeGetPixelHeight: { args: [T.u64], returns: T.u64 },
      CGDisplayModeGetRefreshRate: { args: [T.u64], returns: T.double },
      CGDisplayModeGetIODisplayModeID: { args: [T.u64], returns: T.i32 },
      CGDisplayModeIsUsableForDesktopGUI: { args: [T.u64], returns: T.bool },
      CGDisplayModeRelease: { args: [T.u64], returns: T.void },
    }).symbols;
    const cf = dlopen(CORE_FOUNDATION, {
      CFArrayGetCount: { args: [T.u64], returns: T.i64 },
      CFArrayGetValueAtIndex: { args: [T.u64, T.i64], returns: T.u64 },
      CFRelease: { args: [T.u64], returns: T.void },
    }).symbols;
    loaded = { ...cg, ...cf } as unknown as Symbols;
    return loaded;
  } catch {
    return null;
  }
}

/**
 * Owned `CGDisplayModeRef`s for modes this process has seen as *current*, keyed by their
 * `IODisplayModeID`. This is what makes a restore possible at all — see the header. Bounded by
 * how many modes one session visits, i.e. a handful.
 */
const seen = new Map<string, bigint>();

/** Remember the live mode so it can be switched back to even once it leaves the mode list.
 *  Takes ownership of `ref` (it came from a `Copy` call); an id already held keeps its first
 *  reference and the new one is released, so repeated reads do not leak. */
function remember(lib: Symbols, id: string, ref: bigint): void {
  if (seen.has(id)) {
    lib.CGDisplayModeRelease(ref);
    return;
  }
  seen.set(id, ref);
}

function describe(lib: Symbols, mode: bigint): Omit<HostMode, "current" | "preferred"> & { area: number } {
  const width = Number(lib.CGDisplayModeGetWidth(mode));
  const height = Number(lib.CGDisplayModeGetHeight(mode));
  return {
    id: String(lib.CGDisplayModeGetIODisplayModeID(mode)),
    width,
    height,
    refresh: Math.round(lib.CGDisplayModeGetRefreshRate(mode) * 10) / 10,
    area: width * height,
  };
}

/** Every mode the host's main display can be put into, plus the one it is in now. */
export async function listDarwinResolutions(): Promise<HostResolutions> {
  const lib = await load();
  if (!lib) return { output: null, modes: [], reason: "Cannot reach CoreGraphics on this host." };

  const display = lib.CGMainDisplayID();
  const current = lib.CGDisplayCopyDisplayMode(display);
  let currentId: string | null = null;
  if (current !== 0n) {
    currentId = String(lib.CGDisplayModeGetIODisplayModeID(current));
    remember(lib, currentId, current);
  }

  const rows: (Omit<HostMode, "current" | "preferred"> & { area: number })[] = [];
  const array = lib.CGDisplayCopyAllDisplayModes(display, 0n);
  if (array !== 0n) {
    const count = Number(lib.CFArrayGetCount(array));
    for (let i = 0; i < count; i++) {
      const mode = lib.CFArrayGetValueAtIndex(array, BigInt(i));
      if (mode === 0n) continue;
      // A mode the window server will not run a desktop at is not a mode a user can pick.
      if (!lib.CGDisplayModeIsUsableForDesktopGUI(mode)) continue;
      rows.push(describe(lib, mode));
    }
    lib.CFRelease(array);
  }

  // The live mode is routinely absent from that list on a Retina Mac (header). Without this the
  // menu has nothing ticked and "Original" has nothing to restore to.
  if (currentId !== null && !rows.some((r) => r.id === currentId)) {
    const held = seen.get(currentId);
    if (held !== undefined) rows.push(describe(lib, held));
  }
  if (rows.length === 0) {
    return { output: null, modes: [], reason: "This display advertises no switchable modes." };
  }

  // "Preferred" has no CoreGraphics flag. It is the panel's own 1:1 mode, i.e. the largest size
  // offered — measured by *point* area rather than pixel area, because a Retina scaled mode has
  // the full panel's pixels behind a smaller desktop and would tie with it, putting the native
  // badge on two different sizes in a menu that collapses to one row each.
  const maxArea = Math.max(...rows.map((r) => r.area));
  const modes: HostMode[] = rows.map(({ area, ...row }) => ({
    ...row,
    current: row.id === currentId,
    preferred: area === maxArea,
  }));
  return { output: "Built-in", modes, reason: null };
}

/** Put the host's main display on `modeId`, and report what is live afterwards. */
export async function setDarwinResolution(modeId: string): Promise<SetResolutionResult> {
  const fail = (error: string): SetResolutionResult => ({ ok: false, width: 0, height: 0, error });
  const lib = await load();
  if (!lib) return fail("Cannot reach CoreGraphics on this host.");

  const display = lib.CGMainDisplayID();
  const current = lib.CGDisplayCopyDisplayMode(display);
  if (current !== 0n) remember(lib, String(lib.CGDisplayModeGetIODisplayModeID(current)), current);

  // The mode list first, then the modes this process has held onto. The order matters only for
  // ownership: a mode found in the array is valid while the array is, so the switch happens
  // before it is released.
  let target = 0n;
  const array = lib.CGDisplayCopyAllDisplayModes(display, 0n);
  let status: number | null = null;
  if (array !== 0n) {
    const count = Number(lib.CFArrayGetCount(array));
    for (let i = 0; i < count; i++) {
      const mode = lib.CFArrayGetValueAtIndex(array, BigInt(i));
      if (mode !== 0n && String(lib.CGDisplayModeGetIODisplayModeID(mode)) === modeId) {
        target = mode;
        break;
      }
    }
    if (target !== 0n) status = lib.CGDisplaySetDisplayMode(display, target, 0n);
    lib.CFRelease(array);
  }
  if (status === null) {
    // Not advertised right now — the live Retina mode is the normal case (header).
    const held = seen.get(modeId);
    if (held === undefined) return fail("That mode is not one this host advertises.");
    status = lib.CGDisplaySetDisplayMode(display, held, 0n);
  }
  if (status !== CG_ERROR_SUCCESS) {
    return fail(`The window server refused the mode (CGError ${status}).`);
  }

  // Report what actually took, not what was asked for.
  const after = lib.CGDisplayCopyDisplayMode(display);
  if (after === 0n) return fail("The mode was set but the display could not be read back.");
  const width = Number(lib.CGDisplayModeGetWidth(after));
  const height = Number(lib.CGDisplayModeGetHeight(after));
  remember(lib, String(lib.CGDisplayModeGetIODisplayModeID(after)), after);
  return { ok: true, width, height, error: null };
}
