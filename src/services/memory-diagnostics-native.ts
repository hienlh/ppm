import { readdirSync, readFileSync } from "node:fs";

/**
 * What the OS says this process holds, beyond what `process.memoryUsage()` reports.
 *
 * `rss` is only what is resident right now. A leak of *committed* memory — an allocator
 * segment reserved and never handed back, a pipe buffer per child — can sit at 30 GB of
 * private bytes while RSS reads 1–2 GB, because Windows trims the working set and pages
 * the rest out. That is exactly how the server's leak looked on 20/10/2026: mem-diag said
 * 1 GB, Windows' low-memory detector named the same pid at 32 GB, and every new child
 * process died of memory exhaustion. Private bytes are the number that runs the machine
 * out of commit, so that is the one recorded here.
 *
 * Every field is `undefined` when this platform cannot measure it, never `0`.
 */
export interface NativeMemory {
  /** Windows `PrivateUsage` (commit charge); Linux `RssAnon + VmSwap`. */
  privateMB?: number;
  /** Windows `PeakWorkingSetSize`; Linux `VmHWM`. */
  peakRssMB?: number;
  /** Linux `VmSize` — address space, mostly reservations. */
  virtualMB?: number;
  /** Windows kernel handles; Linux open file descriptors. Climbs with leaked pipes and children. */
  handles?: number;
  /** Linux only: `Threads` in `/proc/self/status`. */
  threads?: number;
}

const MB = 1024 * 1024;

type Win32 = {
  K32GetProcessMemoryInfo: (process: bigint, counters: number, size: number) => number;
  GetProcessHandleCount: (process: bigint, count: number) => number;
};

/** `(HANDLE)-1`, the pseudo handle for the calling process. A bigint, so it crosses FFI unrounded. */
const CURRENT_PROCESS = -1n;
/** `sizeof(PROCESS_MEMORY_COUNTERS_EX)` on 64-bit Windows: two DWORDs then nine SIZE_Ts. */
const COUNTERS_SIZE = 80;
const OFFSET_PEAK_WORKING_SET = 8;
const OFFSET_PRIVATE_USAGE = 72;

let win32: Win32 | null | undefined;

async function loadWin32(): Promise<Win32 | null> {
  if (win32 !== undefined) return win32;
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    win32 = dlopen("kernel32.dll", {
      K32GetProcessMemoryInfo: { args: [FFIType.i64, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      GetProcessHandleCount: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
    }).symbols as unknown as Win32;
  } catch {
    win32 = null;
  }
  return win32;
}

async function readWindows(): Promise<NativeMemory> {
  const lib = await loadWin32();
  if (!lib) return {};
  const { ptr } = await import("bun:ffi");
  const out: NativeMemory = {};

  const counters = new Uint8Array(COUNTERS_SIZE);
  const view = new DataView(counters.buffer);
  view.setUint32(0, COUNTERS_SIZE, true);
  if (lib.K32GetProcessMemoryInfo(CURRENT_PROCESS, ptr(counters), COUNTERS_SIZE) !== 0) {
    out.privateMB = Math.round(Number(view.getBigUint64(OFFSET_PRIVATE_USAGE, true)) / MB);
    out.peakRssMB = Math.round(Number(view.getBigUint64(OFFSET_PEAK_WORKING_SET, true)) / MB);
  }

  const handleCount = new Uint32Array(1);
  if (lib.GetProcessHandleCount(CURRENT_PROCESS, ptr(handleCount)) !== 0) out.handles = handleCount[0];
  return out;
}

/** Parse the `kB` lines of `/proc/self/status` that matter here. Exported for tests. */
export function parseProcStatus(text: string): NativeMemory {
  const kb = (key: string): number | undefined => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m"));
    return m ? Number(m[1]) : undefined;
  };
  const anon = kb("RssAnon");
  const swap = kb("VmSwap");
  const hwm = kb("VmHWM");
  const size = kb("VmSize");
  const threads = text.match(/^Threads:\s+(\d+)/m);
  return {
    privateMB: anon === undefined ? undefined : Math.round((anon + (swap ?? 0)) / 1024),
    peakRssMB: hwm === undefined ? undefined : Math.round(hwm / 1024),
    virtualMB: size === undefined ? undefined : Math.round(size / 1024),
    threads: threads ? Number(threads[1]) : undefined,
  };
}

function readLinux(): NativeMemory {
  const out = parseProcStatus(readFileSync("/proc/self/status", "utf8"));
  try { out.handles = readdirSync("/proc/self/fd").length; } catch { /* fd count is optional */ }
  return out;
}

/** One reading of this process's native memory. Never throws; an unreadable field is left out. */
export async function readNativeMemory(platform: NodeJS.Platform = process.platform): Promise<NativeMemory> {
  try {
    if (platform === "win32") return await readWindows();
    if (platform === "linux") return readLinux();
  } catch { /* fall through: no native reading this tick */ }
  return {};
}
