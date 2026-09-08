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

type Symbols = {
  CGPreflightScreenCaptureAccess: () => boolean;
  CGRequestScreenCaptureAccess: () => boolean;
  AXIsProcessTrusted: () => boolean;
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
  const ax = dlopen(APP_SERVICES, { AXIsProcessTrusted: { args: [], returns: T.bool } }).symbols;
  loaded = { ffi, lib: { ...cg, ...ax } as unknown as Symbols };
  return loaded;
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
  // Accessibility has no prompt API without a CFDictionary (`AXIsProcessTrustedWithOptions` +
  // the `kAXTrustedCheckOptionPrompt` data symbol, which bun:ffi cannot dlsym). The panel
  // deep-links to the Settings pane instead, where the user adds the process by hand.
  return lib.AXIsProcessTrusted();
}
