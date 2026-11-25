/**
 * Which Windows session the PPM process lives in, and whether that session is attached to
 * anything that draws.
 *
 * The failure this exists to explain, measured on a headless Windows 11 host: after a Remote
 * Desktop (RDP) window closes, Windows keeps the user's session running but `Disconnected` — no
 * console, no RDP display — so gdigrab answers `Failed to capture image (error 5)` (access
 * denied) and DXGI enumerates no output at all. PPM runs inside that very session (its autostart
 * task starts it at logon), so the session it reads here is the one a capture would use.
 *
 * `bun:ffi` is required lazily and only on win32, so importing this module on Linux/macOS (and
 * in tests there) never touches `kernel32.dll`.
 */

/** `WTS_CONNECTSTATE_CLASS`, in enum order. */
const CONNECT_STATES = [
  "active", "connected", "connect-query", "shadow", "disconnected",
  "idle", "listen", "reset", "down", "init",
] as const;

export type WindowsConnectState = typeof CONNECT_STATES[number];

export interface WindowsSessionInfo {
  /** The PPM process's own session id. */
  sessionId: number;
  state: WindowsConnectState;
  /** Whether this session is the one on the PC's physical console right now. */
  isConsole: boolean;
}

/** `WTS_CONNECTSTATE_CLASS` value → name; null for anything outside the enum. */
export function connectStateName(value: number): WindowsConnectState | null {
  return Number.isInteger(value) ? CONNECT_STATES[value] ?? null : null;
}

/** `WTS_INFO_CLASS.WTSConnectState`. */
const WTS_CONNECT_STATE = 8;
/** `WTSGetActiveConsoleSessionId` when no session is attached to the console. */
const NO_CONSOLE_SESSION = 0xffffffff;

function openApis() {
  const ffi = require("bun:ffi") as typeof import("bun:ffi");
  const { FFIType: T } = ffi;
  const kernel32 = ffi.dlopen("kernel32.dll", {
    GetCurrentProcessId: { args: [], returns: T.u32 },
    ProcessIdToSessionId: { args: [T.u32, T.ptr], returns: T.i32 },
    WTSGetActiveConsoleSessionId: { args: [], returns: T.u32 },
  });
  const wtsapi32 = ffi.dlopen("wtsapi32.dll", {
    WTSQuerySessionInformationW: { args: [T.ptr, T.u32, T.i32, T.ptr, T.ptr], returns: T.i32 },
    WTSFreeMemory: { args: [T.ptr], returns: T.void },
  });
  return { ffi, kernel32: kernel32.symbols, wtsapi32: wtsapi32.symbols };
}

let apis: ReturnType<typeof openApis> | null | undefined;
function loadApis() {
  if (apis === undefined) {
    try { apis = process.platform === "win32" ? openApis() : null; } catch { apis = null; }
  }
  return apis;
}

/** The connect state of `sessionId`, or null when Windows would not say. The buffer Windows
 *  allocates is freed on every path that received one. */
function querySessionState(api: NonNullable<ReturnType<typeof loadApis>>, sessionId: number): WindowsConnectState | null {
  const { ffi, wtsapi32 } = api;
  const out = new BigUint64Array(1);
  const bytes = new Uint32Array(1);
  if (!wtsapi32.WTSQuerySessionInformationW(null, sessionId, WTS_CONNECT_STATE, ffi.ptr(out), ffi.ptr(bytes))) {
    return null;
  }
  const buffer = Number(out[0]);
  if (!buffer) return null;
  const pointer = buffer as unknown as import("bun:ffi").Pointer;
  try {
    return (bytes[0] ?? 0) >= 4 ? connectStateName(ffi.read.i32(pointer, 0)) : null;
  } finally {
    wtsapi32.WTSFreeMemory(pointer);
  }
}

/** This process's session and its state; null off Windows or when the APIs are unavailable. */
export function readWindowsSession(): WindowsSessionInfo | null {
  const api = loadApis();
  if (!api) return null;
  try {
    const id = new Uint32Array(1);
    if (!api.kernel32.ProcessIdToSessionId(api.kernel32.GetCurrentProcessId(), api.ffi.ptr(id))) return null;
    const sessionId = id[0] ?? 0;
    const state = querySessionState(api, sessionId);
    if (!state) return null;
    const console = api.kernel32.WTSGetActiveConsoleSessionId();
    return { sessionId, state, isConsole: console !== NO_CONSOLE_SESSION && console === sessionId };
  } catch {
    return null;
  }
}
