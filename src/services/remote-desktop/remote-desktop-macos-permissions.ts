/**
 * macOS TCC pre-flight for the two grants remote desktop needs, via Bun FFI. Both checks are
 * cheap and side-effect free; the `request*` calls make macOS show its own prompt (once per
 * grant — a denied prompt never re-appears, the user then has to use System Settings).
 *
 * Why pre-flight instead of reacting to failures: without Screen Recording, avfoundation still
 * runs and hands ffmpeg **black frames**; without Accessibility, `CGEventPost` is a silent
 * no-op. Neither path produces an error the session could surface.
 *
 * TCC keys command-line tools by executable — the grant lands on `bun` (the PPM daemon's
 * binary), not on a terminal or on PPM. Frameworks are `dlopen`-ed lazily and only on darwin.
 */
const CG = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
const APP_SERVICES = "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices";

const CORE_FOUNDATION = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const LIB_SYSTEM = "/usr/lib/libSystem.B.dylib";

type Symbols = {
  CGPreflightScreenCaptureAccess: () => boolean;
  CGRequestScreenCaptureAccess: () => boolean;
  AXIsProcessTrusted: () => boolean;
  AXIsProcessTrustedWithOptions: (options: bigint) => boolean;
  CFDictionaryCreate: (
    allocator: bigint, keys: unknown, values: unknown, count: number,
    keyCallBacks: bigint, valueCallBacks: bigint,
  ) => bigint;
  CFRelease: (ref: bigint) => void;
  dlsym: (handle: bigint, name: unknown) => bigint;
};

let loaded: { ffi: typeof import("bun:ffi"); lib: Symbols } | null = null;

async function load() {
  if (loaded) return loaded;
  const ffi = await import("bun:ffi");
  const { dlopen, FFIType: T } = ffi;
  const cg = dlopen(CG, {
    CGPreflightScreenCaptureAccess: { args: [], returns: T.bool },
    CGRequestScreenCaptureAccess: { args: [], returns: T.bool },
  }).symbols;
  const ax = dlopen(APP_SERVICES, {
    AXIsProcessTrusted: { args: [], returns: T.bool },
    AXIsProcessTrustedWithOptions: { args: [T.u64], returns: T.bool },
  }).symbols;
  const cf = dlopen(CORE_FOUNDATION, {
    // Every CF ref crosses as u64, never T.ptr — a tagged pointer is not a pointer.
    CFDictionaryCreate: { args: [T.u64, T.ptr, T.ptr, T.i64, T.u64, T.u64], returns: T.u64 },
    CFRelease: { args: [T.u64], returns: T.void },
  }).symbols;
  const sys = dlopen(LIB_SYSTEM, { dlsym: { args: [T.u64, T.ptr], returns: T.u64 } }).symbols;
  loaded = { ffi, lib: { ...cg, ...ax, ...cf, ...sys } as unknown as Symbols };
  return loaded;
}

/** `RTLD_DEFAULT` is `(void *)-2`: search every image already loaded, which the `dlopen`s above
 *  have just guaranteed for the two frameworks. */
const RTLD_DEFAULT = 0xFFFFFFFFFFFFFFFEn;

/**
 * Ask macOS itself for the Accessibility grant.
 *
 * This was previously documented here as impossible, because the call needs a CFDictionary whose
 * key is `kAXTrustedCheckOptionPrompt` — a **data** symbol, which `dlopen` in bun:ffi does not
 * expose. That is true of `dlopen`, and irrelevant: `dlsym` is an ordinary function, so it binds
 * like any other and hands back the address of the variable, which `read.u64` dereferences.
 * Measured — all four symbols this needs resolve (`kAXTrustedCheckOptionPrompt`, `kCFBooleanTrue`
 * and the two callback structs, the latter two being the structs themselves rather than pointers
 * to them, so their addresses are passed as-is).
 *
 * It matters because the alternative is what the panel used to offer alone: a deep link to the
 * Settings pane and an instruction to add the binary by hand. Measured on the dev host, that path
 * **silently does not work** for a command-line tool — after the user had done it, `tccutil reset
 * Accessibility bun` answered *"No such bundle identifier"*, i.e. no entry had been created at
 * all, while `AXIsProcessTrusted()` kept answering false in every PPM process on the machine with
 * nothing to say why. Letting macOS create the entry is the only reliable way to get one.
 *
 * The prompt appears **once** per client: a dismissed or denied one never returns, which is why
 * the Settings deep link stays beside this rather than being replaced by it.
 */
async function requestAccessibility(): Promise<boolean> {
  const { ffi, lib } = await load();
  const { ptr, read } = ffi;
  const symbolAddress = (name: string) => lib.dlsym(RTLD_DEFAULT, ptr(Buffer.from(`${name}\0`, "utf8")));
  /** The symbol *is* the variable, so its value is one dereference away. */
  const cfRef = (name: string) => read.u64(Number(symbolAddress(name)) as unknown as import("bun:ffi").Pointer);

  const keys = new BigUint64Array([cfRef("kAXTrustedCheckOptionPrompt")]);
  const values = new BigUint64Array([cfRef("kCFBooleanTrue")]);
  const options = lib.CFDictionaryCreate(
    0n, ptr(keys), ptr(values), 1,
    symbolAddress("kCFTypeDictionaryKeyCallBacks"), symbolAddress("kCFTypeDictionaryValueCallBacks"),
  );
  // A NULL dictionary would make this the plain `AXIsProcessTrusted` and show nothing, so it is
  // worth failing loudly rather than reporting a prompt that never appeared.
  if (options === 0n) return lib.AXIsProcessTrusted();
  const trusted = lib.AXIsProcessTrustedWithOptions(options);
  lib.CFRelease(options);
  return trusted;
}

export type MacPermissionId = "screen-recording" | "accessibility";

/** System Settings deep links (macOS 13+ pane ids). */
export const MAC_PERMISSION_SETTINGS_URL: Record<MacPermissionId, string> = {
  "screen-recording": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
};

/** Current grant state. Off darwin both are reported as granted so callers need no OS branch. */
export async function macPermissionStatus(): Promise<Record<MacPermissionId, boolean>> {
  if (process.platform !== "darwin") return { "screen-recording": true, accessibility: true };
  const { lib } = await load();
  return { "screen-recording": lib.CGPreflightScreenCaptureAccess(), accessibility: lib.AXIsProcessTrusted() };
}

/** Ask macOS to show the grant prompt. Returns the state *after* the call — for Accessibility
 *  the prompt is asynchronous, so the caller should keep polling `macPermissionStatus()`. */
export async function requestMacPermission(id: MacPermissionId): Promise<boolean> {
  if (process.platform !== "darwin") return true;
  const { lib } = await load();
  if (id === "screen-recording") return lib.CGRequestScreenCaptureAccess();
  return requestAccessibility();
}
