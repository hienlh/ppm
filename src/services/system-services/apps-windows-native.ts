/**
 * The Win32 calls behind the Apps page on Windows, through bun:ffi: which processes own
 * a window a person would call an app, where each one's executable is, and what that
 * executable calls itself. No PowerShell and no spawn — the whole read is in-process,
 * a few ms per tick, because the tick budget is already spent on the PowerShell round
 * trip that feeds the process table.
 *
 * Which windows count is Task Manager's own rule, approximately: top-level, visible,
 * unowned, titled, not a tool window, and not cloaked. Cloaking is the case that is easy
 * to miss — a suspended Store app keeps a visible, titled window that DWM simply does
 * not draw, and without the check Settings and Calculator list long after they closed.
 * The desktop and the taskbar are visible titled top-level windows too, so their classes
 * are excluded by name.
 *
 * Everything here returns an empty answer rather than throwing when a library or an
 * export is missing: the Apps page is an optional view, not a reason to fail a tick.
 */
import { dlopen, FFIType, JSCallback, ptr } from "bun:ffi";

const GW_OWNER = 4;
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x80;
const WS_EX_APPWINDOW = 0x40000;
const DWMWA_CLOAKED = 14;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

/** The desktop, the taskbars and the shell's hidden hosts. */
const SHELL_CLASSES = new Set(["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"]);

type Libs = {
  user32: ReturnType<typeof openUser32>;
  kernel32: ReturnType<typeof openKernel32>;
  dwmapi: ReturnType<typeof openDwmapi> | null;
  version: ReturnType<typeof openVersion> | null;
};

function openUser32() {
  return dlopen("user32.dll", {
    EnumWindows: { args: [FFIType.function, FFIType.i64], returns: FFIType.i32 },
    IsWindowVisible: { args: [FFIType.ptr], returns: FFIType.i32 },
    GetWindow: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
    GetWindowTextLengthW: { args: [FFIType.ptr], returns: FFIType.i32 },
    GetWindowTextW: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    GetClassNameW: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    GetWindowLongPtrW: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i64 },
    GetWindowThreadProcessId: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
  }).symbols;
}

function openKernel32() {
  return dlopen("kernel32.dll", {
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    QueryFullProcessImageNameW: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
}

function openDwmapi() {
  return dlopen("dwmapi.dll", {
    DwmGetWindowAttribute: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  }).symbols;
}

function openVersion() {
  return dlopen("version.dll", {
    GetFileVersionInfoSizeW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    GetFileVersionInfoW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    VerQueryValueW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
}

let libs: Libs | null | undefined;

function load(): Libs | null {
  if (libs !== undefined) return libs;
  if (process.platform !== "win32") return (libs = null);
  try {
    const optional = <T>(open: () => T): T | null => { try { return open(); } catch { return null; } };
    libs = { user32: openUser32(), kernel32: openKernel32(), dwmapi: optional(openDwmapi), version: optional(openVersion) };
  } catch {
    libs = null;
  }
  return libs;
}

const wide = (s: string) => Buffer.from(`${s}\0`, "utf16le");
const fromWide = (buf: Buffer, chars: number) => buf.toString("utf16le", 0, chars * 2);

/**
 * The EnumWindows callback is held here for the life of the process. A JSCallback that
 * is collected while native code still holds its trampoline is a crash, not an error,
 * and EnumWindows is called on every tick.
 */
let enumCallback: JSCallback | null = null;
let collected: number[] = [];

export interface AppWindow {
  pid: number;
  title: string;
}

/**
 * Every window that counts as an app window, with its owner. All of them, not one per
 * process: Store apps all draw through one ApplicationFrameHost process, and keeping only
 * its first window would drop every Store app after the first.
 */
export function appWindowOwners(): AppWindow[] {
  const l = load();
  const owners: AppWindow[] = [];
  if (!l) return owners;
  const { user32, dwmapi } = l;

  enumCallback ??= new JSCallback(
    (hwnd: number) => { collected.push(hwnd); return 1; },
    { args: [FFIType.ptr, FFIType.i64], returns: FFIType.i32 },
  );
  collected = [];
  try {
    user32.EnumWindows(enumCallback.ptr!, 0n as unknown as number);
  } catch {
    return owners;
  }

  const pidBuf = new Uint32Array(1);
  const cloakBuf = new Uint32Array(1);
  const classBuf = Buffer.alloc(256 * 2);
  for (const hwnd of collected) {
    if (!user32.IsWindowVisible(hwnd as never)) continue;
    if (user32.GetWindow(hwnd as never, GW_OWNER)) continue;
    const titleLen = user32.GetWindowTextLengthW(hwnd as never);
    if (titleLen <= 0) continue;
    const ex = Number(user32.GetWindowLongPtrW(hwnd as never, GWL_EXSTYLE));
    if ((ex & WS_EX_TOOLWINDOW) && !(ex & WS_EX_APPWINDOW)) continue;
    if (dwmapi) {
      cloakBuf[0] = 0;
      if (dwmapi.DwmGetWindowAttribute(hwnd as never, DWMWA_CLOAKED, ptr(cloakBuf), 4) === 0 && cloakBuf[0] !== 0) continue;
    }
    const classLen = user32.GetClassNameW(hwnd as never, ptr(classBuf), 256);
    if (classLen > 0 && SHELL_CLASSES.has(fromWide(classBuf, classLen))) continue;

    user32.GetWindowThreadProcessId(hwnd as never, ptr(pidBuf));
    const pid = pidBuf[0]!;
    if (!pid) continue;
    const title = Buffer.alloc((titleLen + 1) * 2);
    const got = user32.GetWindowTextW(hwnd as never, ptr(title), titleLen + 1);
    owners.push({ pid, title: fromWide(title, got) });
  }
  return owners;
}

/** The full path of a process's executable, or null when it cannot be opened (another
 *  user's process, a protected one, or one that has exited). */
export function processImagePath(pid: number): string | null {
  const l = load();
  if (!l) return null;
  const { kernel32 } = l;
  const handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!handle) return null;
  try {
    const buf = Buffer.alloc(1024 * 2);
    const size = new Uint32Array([1024]);
    if (!kernel32.QueryFullProcessImageNameW(handle, 0, ptr(buf), ptr(size))) return null;
    return fromWide(buf, size[0]!);
  } finally {
    kernel32.CloseHandle(handle);
  }
}

/**
 * The executable's `FileDescription` ("Google Chrome", "Windows Explorer") from its
 * version resource, in the first language the resource lists. Null when it has none.
 */
export function fileDescription(exePath: string): string | null {
  const l = load();
  if (!l?.version) return null;
  const { version } = l;
  const path = wide(exePath);
  const size = version.GetFileVersionInfoSizeW(ptr(path), null);
  if (!size || size > 4 * 1024 * 1024) return null;
  const data = Buffer.alloc(size);
  if (!version.GetFileVersionInfoW(ptr(path), 0, size, ptr(data))) return null;
  const base = ptr(data) as unknown as number;

  /** VerQueryValueW answers with a pointer INTO `data`; read it back as an offset. */
  const query = (sub: string): { offset: number; len: number } | null => {
    const out = new BigUint64Array(1);
    const len = new Uint32Array(1);
    if (!version.VerQueryValueW(ptr(data), ptr(wide(sub)), ptr(out), ptr(len)) || !len[0]) return null;
    const offset = Number(out[0]!) - base;
    return offset >= 0 && offset < size ? { offset, len: len[0]! } : null;
  };

  const translation = query("\\VarFileInfo\\Translation");
  const langs: string[] = [];
  if (translation && translation.len >= 4) {
    const lang = data.readUInt16LE(translation.offset);
    const cp = data.readUInt16LE(translation.offset + 2);
    langs.push(`${hex4(lang)}${hex4(cp)}`);
  }
  // US English in Unicode and in Windows-1252: what most resources use when the
  // translation table is missing or names a block that is not there.
  langs.push("040904b0", "040904e4");
  for (const lang of langs) {
    const hit = query(`\\StringFileInfo\\${lang}\\FileDescription`);
    if (!hit) continue;
    // `len` is in characters and includes the terminator.
    const text = data.toString("utf16le", hit.offset, Math.min(size, hit.offset + hit.len * 2)).replace(/\0+$/, "").trim();
    if (text) return text;
  }
  return null;
}

const hex4 = (n: number) => n.toString(16).padStart(4, "0");
