/**
 * Integrity levels of PPM itself and of the process owning the foreground window, for the input
 * backend to tell a UIPI block apart from input that got through (`remote-desktop-input-block.ts`).
 *
 * Read-only Win32 over `bun:ffi`, loaded lazily so non-Windows imports stay harmless. Two traps:
 * - `GetCurrentProcess()` returns the pseudo-handle -1, which `T.ptr` turns into a JS number that
 *   cannot hold it; PPM opens its own pid like any other instead.
 * - The pointer is moved 60 times a second, so the foreground is looked up per send but its
 *   process is inspected only when the window changes.
 */
import type { Pointer } from "bun:ffi";
import type { ForegroundProcess } from "./remote-desktop-input-block.ts";

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const TOKEN_QUERY = 0x8;
const TOKEN_INTEGRITY_LEVEL = 25;

function openApis() {
  const ffi = require("bun:ffi") as typeof import("bun:ffi");
  const { FFIType: T } = ffi;
  const user32 = ffi.dlopen("user32.dll", {
    GetForegroundWindow: { args: [], returns: T.ptr },
    GetWindowThreadProcessId: { args: [T.ptr, T.ptr], returns: T.u32 },
  }).symbols;
  const kernel32 = ffi.dlopen("kernel32.dll", {
    OpenProcess: { args: [T.u32, T.bool, T.u32], returns: T.ptr },
    CloseHandle: { args: [T.ptr], returns: T.bool },
    QueryFullProcessImageNameW: { args: [T.ptr, T.u32, T.ptr, T.ptr], returns: T.bool },
  }).symbols;
  const advapi32 = ffi.dlopen("advapi32.dll", {
    OpenProcessToken: { args: [T.ptr, T.u32, T.ptr], returns: T.bool },
    GetTokenInformation: { args: [T.ptr, T.u32, T.ptr, T.u32, T.ptr], returns: T.bool },
    GetSidSubAuthorityCount: { args: [T.ptr], returns: T.ptr },
    GetSidSubAuthority: { args: [T.ptr, T.u32], returns: T.ptr },
  }).symbols;
  return { ffi, user32, kernel32, advapi32 };
}

let apis: ReturnType<typeof openApis> | null | undefined;
function load() {
  if (apis === undefined) {
    try { apis = process.platform === "win32" ? openApis() : null; } catch { apis = null; }
  }
  return apis;
}

/** The process's mandatory integrity level, or null when its token cannot be opened from here. */
function integrityOfHandle(a: NonNullable<ReturnType<typeof load>>, process: Pointer): number | null {
  const out = new BigUint64Array(1);
  if (!a.advapi32.OpenProcessToken(process, TOKEN_QUERY, a.ffi.ptr(out))) return null;
  const token = Number(out[0]) as Pointer;
  try {
    const buf = new Uint8Array(128);
    const len = new Uint32Array(1);
    if (!a.advapi32.GetTokenInformation(token, TOKEN_INTEGRITY_LEVEL, a.ffi.ptr(buf), buf.byteLength, a.ffi.ptr(len))) return null;
    // TOKEN_MANDATORY_LABEL { SID_AND_ATTRIBUTES Label }: the SID pointer comes first.
    const sid = a.ffi.read.ptr(a.ffi.ptr(buf), 0) as Pointer;
    const countPtr = a.advapi32.GetSidSubAuthorityCount(sid);
    if (!countPtr) return null;
    const count = a.ffi.read.u8(countPtr, 0);
    if (count === 0) return null;
    const rid = a.advapi32.GetSidSubAuthority(sid, count - 1);
    return rid ? a.ffi.read.u32(rid, 0) : null;
  } finally {
    a.kernel32.CloseHandle(token);
  }
}

function exeOfHandle(a: NonNullable<ReturnType<typeof load>>, process: Pointer): string | null {
  const name = new Uint16Array(520);
  const size = new Uint32Array([name.length]);
  if (!a.kernel32.QueryFullProcessImageNameW(process, 0, a.ffi.ptr(name), a.ffi.ptr(size))) return null;
  const full = String.fromCharCode(...name.subarray(0, size[0]));
  return full.split("\\").pop() || null;
}

/** Integrity level and file name of a process; integrity null when it outranks PPM. */
export function inspectProcess(pid: number): ForegroundProcess | null {
  const a = load();
  if (!a) return null;
  const handle = a.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  // A process PPM may not even query (a protected or SYSTEM one) is above it, too.
  if (!handle) return { pid, exe: null, integrity: null };
  try {
    return { pid, exe: exeOfHandle(a, handle), integrity: integrityOfHandle(a, handle) };
  } finally {
    a.kernel32.CloseHandle(handle);
  }
}

let own: number | null | undefined;
/** PPM's own level (Medium for a normal user session), read once. */
export function ownIntegrity(): number | null {
  if (own === undefined) own = inspectProcess(process.pid)?.integrity ?? null;
  return own;
}

let cached: { pid: number; info: ForegroundProcess | null } | null = null;
/** The process owning the foreground window of the input desktop this thread is attached to.
 *  Keyed by pid, not window handle: Windows reuses handles, and two windows of one app share a
 *  level. */
export function foregroundProcess(): ForegroundProcess | null {
  const a = load();
  if (!a) return null;
  try {
    const hwnd = a.user32.GetForegroundWindow();
    if (!hwnd) return null;
    const pidOut = new Uint32Array(1);
    a.user32.GetWindowThreadProcessId(hwnd, a.ffi.ptr(pidOut));
    const pid = pidOut[0]!;
    if (!pid) return null;
    if (cached?.pid !== pid) cached = { pid, info: inspectProcess(pid) };
    return cached.info;
  } catch {
    return null;
  }
}
