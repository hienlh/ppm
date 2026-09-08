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
 */

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

export async function listDisplays(platform: NodeJS.Platform = process.platform): Promise<RemoteDisplay[]> {
  if (platform === "win32") {
    return [{ id: "desktop", label: "All displays", primary: true, x: 0, y: 0, width: 0, height: 0, captureIndex: 0 }];
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
