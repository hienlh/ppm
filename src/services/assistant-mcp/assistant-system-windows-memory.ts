import { querySystemProcessInformation } from "../process-thread-snapshot.ts";
import { parseWindowsProcessList, type ProcessMemoryEntry } from "../process-tree-memory.ts";

/**
 * The Windows figures `system_resources` needs and no collector keeps: machine commit, page-file
 * use, and each process's working set beside its private bytes. All three are kernel reads over
 * `bun:ffi` (the way `memory-diagnostics-native.ts` and `process-tree-memory.ts` read memory),
 * taken once per call with no child process — a PowerShell spawn per call costs a 32 MiB segment
 * Bun never returns. Any failure leaves the figure out; nothing here throws.
 */

const MB = 1024 * 1024;

export interface WindowsCommit {
  commitUsedMB: number;
  commitLimitMB: number;
  commitPeakMB: number;
  /** Bytes per page, which the page-file figures are counted in. */
  pageSize: number;
}

export interface PageFileUse {
  /** The file's path as the kernel names it, `\??\` dropped (`C:\pagefile.sys`); null when unreadable. */
  name: string | null;
  sizeMB: number;
  inUseMB: number;
  peakMB: number;
}

export interface WindowsProcessMemory extends ProcessMemoryEntry {
  workingSetMB: number;
}

type Kernel32 = { K32GetPerformanceInfo: (info: number, size: number) => number };
type Ntdll = { NtQuerySystemInformation: (cls: number, buf: number, len: number, ret: number) => number };
let kernel32: Kernel32 | null | undefined;
let ntdll: Ntdll | null | undefined;

async function loadKernel32(): Promise<Kernel32 | null> {
  if (kernel32 !== undefined) return kernel32;
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    kernel32 = dlopen("kernel32.dll", {
      K32GetPerformanceInfo: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    }).symbols as unknown as Kernel32;
  } catch {
    kernel32 = null;
  }
  return kernel32;
}

async function loadNtdll(): Promise<Ntdll | null> {
  if (ntdll !== undefined) return ntdll;
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    ntdll = dlopen("ntdll.dll", {
      NtQuerySystemInformation: { args: [FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    }).symbols as unknown as Ntdll;
  } catch {
    ntdll = null;
  }
  return ntdll;
}

// PERFORMANCE_INFORMATION on 64-bit Windows: a DWORD `cb` padded to 8, ten SIZE_Ts, three DWORDs.
const PERF_SIZE = 104;
const PERF_COMMIT_TOTAL = 8;
const PERF_COMMIT_LIMIT = 16;
const PERF_COMMIT_PEAK = 24;
const PERF_PAGE_SIZE = 80;

/** Commit figures from a filled `PERFORMANCE_INFORMATION`. Exported for tests. */
export function parsePerformanceInformation(view: DataView): WindowsCommit | null {
  const pageSize = Number(view.getBigUint64(PERF_PAGE_SIZE, true));
  if (!pageSize) return null;
  const mb = (offset: number) => Math.round((Number(view.getBigUint64(offset, true)) * pageSize) / MB);
  return { commitUsedMB: mb(PERF_COMMIT_TOTAL), commitLimitMB: mb(PERF_COMMIT_LIMIT), commitPeakMB: mb(PERF_COMMIT_PEAK), pageSize };
}

export async function readWindowsCommit(platform: NodeJS.Platform = process.platform): Promise<WindowsCommit | null> {
  if (platform !== "win32") return null;
  try {
    const lib = await loadKernel32();
    if (!lib) return null;
    const { ptr } = await import("bun:ffi");
    const buf = new Uint8Array(PERF_SIZE);
    const view = new DataView(buf.buffer);
    view.setUint32(0, PERF_SIZE, true);
    if (lib.K32GetPerformanceInfo(ptr(buf), PERF_SIZE) === 0) return null;
    return parsePerformanceInformation(view);
  } catch {
    return null;
  }
}

// SYSTEM_PAGEFILE_INFORMATION on 64-bit Windows: four ULONGs, then a UNICODE_STRING
// (USHORT Length, USHORT MaximumLength, 4 bytes of padding, PWSTR Buffer).
const SYSTEM_PAGEFILE_INFORMATION = 18;
const PF_NEXT = 0;
const PF_TOTAL = 4;
const PF_IN_USE = 8;
const PF_PEAK = 12;
const PF_NAME_LENGTH = 16;
const PF_NAME_BUFFER = 24;
const PF_SIZE = 32;
const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004 | 0;

/** Every page file in a `SystemPageFileInformation` buffer of `length` bytes. Exported for tests. */
export function parsePageFileList(view: DataView, base: bigint, length: number, pageSize: number): PageFileUse[] {
  const out: PageFileUse[] = [];
  const mb = (pages: number) => Math.round((pages * pageSize) / MB);
  let at = 0;
  while (length > 0 && at + PF_SIZE <= Math.min(length, view.byteLength)) {
    let name: string | null = null;
    const nameBytes = view.getUint16(at + PF_NAME_LENGTH, true);
    // The name's buffer points into the same block; anything outside it is not read.
    const offset = Number(view.getBigUint64(at + PF_NAME_BUFFER, true) - base);
    if (nameBytes > 0 && offset >= 0 && offset + nameBytes <= view.byteLength) {
      name = new TextDecoder("utf-16le").decode(new Uint8Array(view.buffer, view.byteOffset + offset, nameBytes)).replace(/^\\\?\?\\/, "");
    }
    out.push({
      name,
      sizeMB: mb(view.getUint32(at + PF_TOTAL, true)),
      inUseMB: mb(view.getUint32(at + PF_IN_USE, true)),
      peakMB: mb(view.getUint32(at + PF_PEAK, true)),
    });
    const next = view.getUint32(at + PF_NEXT, true);
    if (next === 0) break;
    at += next;
  }
  return out;
}

/** Page files in use; an empty list when the machine has none, null when they cannot be read. */
export async function readPageFiles(pageSize: number, platform: NodeJS.Platform = process.platform): Promise<PageFileUse[] | null> {
  if (platform !== "win32" || !pageSize) return null;
  try {
    const lib = await loadNtdll();
    if (!lib) return null;
    const { ptr } = await import("bun:ffi");
    let size = 4096;
    for (let attempt = 0; attempt < 4; attempt++) {
      const buf = new Uint8Array(size);
      const returned = new Uint32Array(1);
      const status = lib.NtQuerySystemInformation(SYSTEM_PAGEFILE_INFORMATION, ptr(buf), buf.byteLength, ptr(returned));
      if (status === STATUS_INFO_LENGTH_MISMATCH) { size = Math.max(size * 2, (returned[0] ?? 0) + 1024); continue; }
      if (status !== 0) return null;
      return parsePageFileList(new DataView(buf.buffer), BigInt(ptr(buf)), returned[0] ?? 0, pageSize);
    }
  } catch { /* the figure is left out */ }
  return null;
}

// SYSTEM_PROCESS_INFORMATION on 64-bit Windows, the fields `process-tree-memory.ts` does not read.
const P_NEXT = 0x00;
const P_PID = 0x50;
const P_WORKING_SET = 0x90;
const P_SIZE = 0x100;

/** pid → working set, MB, from the same buffer `parseWindowsProcessList` reads. Exported for tests. */
export function parseWorkingSets(view: DataView): Map<number, number> {
  const out = new Map<number, number>();
  let at = 0;
  while (at + P_SIZE <= view.byteLength) {
    const pid = Number(view.getBigUint64(at + P_PID, true));
    if (!out.has(pid)) out.set(pid, Math.round(Number(view.getBigUint64(at + P_WORKING_SET, true)) / MB));
    const next = view.getUint32(at + P_NEXT, true);
    if (next === 0) break;
    at += next;
  }
  return out;
}

/** Every process with private bytes and working set, from one kernel read; null when unreadable. */
export async function readWindowsProcessMemory(platform: NodeJS.Platform = process.platform): Promise<WindowsProcessMemory[] | null> {
  if (platform !== "win32") return null;
  try {
    const info = await querySystemProcessInformation();
    if (!info) return null;
    const workingSets = parseWorkingSets(info.view);
    return parseWindowsProcessList(info.view, info.base).map((p) => ({ ...p, workingSetMB: workingSets.get(p.pid) ?? 0 }));
  } catch {
    return null;
  }
}
