/**
 * The macOS kernel figures the System Monitor reads straight from libSystem over
 * bun:ffi instead of spawning a tool for each: `sysctlbyname`, the VM page counts
 * behind `vm_stat` and the scheduler's thread total.
 *
 * Two reasons this is FFI rather than `sysctl`/`vm_stat` in a subprocess. The
 * memory figures run on BOTH tiers — the light one feeds the status bar on every
 * page — and a spawn per tick there was the one process the light tier started.
 * And every call here was measured at well under a millisecond (0.002 ms for the
 * page counts once the library is open, against ~1.3 ms for the cheapest spawn),
 * so nothing below needs to be async.
 *
 * Every struct layout is from the macOS SDK headers and was checked against the
 * tool that prints the same numbers on a real M1 Max (`vm_stat`, `sysctl
 * vm.swapusage`): a wrong offset does not fail, it reads a neighbouring field and
 * returns a plausible number, so the parsers are pure and pinned by tests.
 *
 * Nothing is opened until first asked for, and a host where libSystem cannot be
 * reached (anything but darwin) answers `undefined` for every figure — which the
 * callers render as "not measured", never as zero.
 */
import { dlopen, FFIType as T, ptr } from "bun:ffi";

const LIBSYSTEM = "/usr/lib/libSystem.B.dylib";
const KERN_SUCCESS = 0;

/** `<mach/host_info.h>`: HOST_VM_INFO64, and its count in `integer_t` units. */
const HOST_VM_INFO64 = 4;
export const VM_STATISTICS64_BYTES = 152;
const HOST_VM_INFO64_COUNT = VM_STATISTICS64_BYTES / 4;

/** `<mach/processor_info.h>`: PROCESSOR_SET_LOAD_INFO = { task_count, thread_count, load_average, mach_factor }. */
const PROCESSOR_SET_LOAD_INFO = 4;
const PROCESSOR_SET_LOAD_INFO_COUNT = 4;

/** `struct xsw_usage` from `<sys/sysctl.h>`: three u64 then a u32 page size and a boolean_t. */
export const XSW_USAGE_BYTES = 32;

/** The fields of `vm_statistics64` this code reads, in pages. */
export interface VmStatistics64 {
  free: number;
  active: number;
  inactive: number;
  wire: number;
  purgeable: number;
  speculative: number;
  /** Pages the compressor itself occupies — what Activity Monitor calls "Compressed". */
  compressor: number;
  throttled: number;
  /** File-backed pages. */
  external: number;
  /** Anonymous pages. */
  internal: number;
  /** Pages' worth of data held inside the compressor, before compression. */
  uncompressedInCompressor: number;
}

export interface SwapUsage {
  totalBytes: number;
  usedBytes: number;
}

export interface ProcessorSetLoad {
  taskCount: number;
  threadCount: number;
}

/** What the collectors ask of the kernel. Injected, so every consumer is tested
 *  against a fake and only this file ever touches a real symbol. */
export interface DarwinKernel {
  /** An integer sysctl (4 or 8 bytes). Undefined when the name does not exist
   *  on this host — `hw.l3cachesize` on Apple Silicon, `hw.perflevel0.*` on Intel. */
  sysctlNumber(name: string): number | undefined;
  sysctlString(name: string): string | undefined;
  /** A struct-valued sysctl, raw. */
  sysctlBytes(name: string): Uint8Array | undefined;
  vmStatistics(): VmStatistics64 | undefined;
  processorSetLoad(): ProcessorSetLoad | undefined;
}

/**
 * `vm_statistics64` as `<mach/vm_statistics.h>` lays it out (8-byte aligned,
 * 152 bytes). Offsets verified field by field against `vm_stat` on macOS 15.
 */
export function parseVmStatistics64(bytes: Uint8Array): VmStatistics64 | undefined {
  if (bytes.byteLength < VM_STATISTICS64_BYTES) return undefined;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (o: number) => v.getUint32(o, true);
  return {
    free: u32(0),
    active: u32(4),
    inactive: u32(8),
    wire: u32(12),
    purgeable: u32(88),
    speculative: u32(92),
    compressor: u32(128),
    throttled: u32(132),
    external: u32(136),
    internal: u32(140),
    uncompressedInCompressor: Number(v.getBigUint64(144, true)),
  };
}

export function parseXswUsage(bytes: Uint8Array): SwapUsage | undefined {
  if (bytes.byteLength < XSW_USAGE_BYTES) return undefined;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const totalBytes = Number(v.getBigUint64(0, true));
  const usedBytes = Number(v.getBigUint64(16, true));
  // A used figure above the total is a sample taken while the swap file was
  // being resized, not a bigger swap.
  return { totalBytes, usedBytes: Math.min(usedBytes, totalBytes) };
}

/** A sysctl value by its length: `int` sysctls are 4 bytes, `quad` ones 8. */
export function decodeSysctlNumber(bytes: Uint8Array): number | undefined {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength === 4) return v.getInt32(0, true);
  if (bytes.byteLength === 8) return Number(v.getBigInt64(0, true));
  return undefined;
}

export function decodeSysctlString(bytes: Uint8Array): string | undefined {
  const text = new TextDecoder().decode(bytes).replace(/\0+$/, "");
  return text.length > 0 ? text : undefined;
}

type Symbols = {
  sysctlbyname: (name: Uint8Array | number, oldp: number | null, oldlenp: number, newp: null, newlen: bigint) => number;
  mach_host_self: () => number;
  host_statistics64: (host: number, flavor: number, info: number, count: number) => number;
  processor_set_default: (host: number, pset: number) => number;
  processor_set_statistics: (pset: number, flavor: number, info: number, count: number) => number;
};

/** `undefined` until first asked for; `null` where libSystem cannot be opened. */
let lib: Symbols | null | undefined;
/** Send rights, taken once. `mach_host_self()` adds a user reference on every
 *  call and `processor_set_default` hands out a right each time, so asking per
 *  tick would leak one per tick for the life of the server. */
let hostPort = 0;
let psetPort = 0;
const encoder = new TextEncoder();

function open(): Symbols | null {
  if (lib !== undefined) return lib;
  lib = null;
  if (process.platform !== "darwin") return null;
  try {
    lib = dlopen(LIBSYSTEM, {
      sysctlbyname: { args: [T.ptr, T.ptr, T.ptr, T.ptr, T.u64], returns: T.i32 },
      mach_host_self: { args: [], returns: T.u32 },
      host_statistics64: { args: [T.u32, T.i32, T.ptr, T.ptr], returns: T.i32 },
      processor_set_default: { args: [T.u32, T.ptr], returns: T.i32 },
      processor_set_statistics: { args: [T.u32, T.i32, T.ptr, T.ptr], returns: T.i32 },
    }).symbols as unknown as Symbols;
  } catch {
    lib = null;
  }
  return lib;
}

function host(l: Symbols): number {
  if (hostPort === 0) hostPort = l.mach_host_self();
  return hostPort;
}

function sysctlRaw(name: string): Uint8Array | undefined {
  const l = open();
  if (!l) return undefined;
  const key = encoder.encode(`${name}\0`);
  const len = new BigUint64Array(1);
  // First call sizes the value, second reads it; a name this kernel does not
  // have fails the first with ENOENT.
  if (l.sysctlbyname(key, null, ptr(len), null, 0n) !== 0) return undefined;
  const size = Number(len[0]);
  if (!(size > 0) || size > 1 << 20) return undefined;
  const buf = new Uint8Array(size);
  if (l.sysctlbyname(key, ptr(buf), ptr(len), null, 0n) !== 0) return undefined;
  return buf.subarray(0, Math.min(size, Number(len[0])));
}

const realKernel: DarwinKernel = {
  sysctlNumber(name) {
    const bytes = sysctlRaw(name);
    return bytes ? decodeSysctlNumber(bytes) : undefined;
  },
  sysctlString(name) {
    const bytes = sysctlRaw(name);
    return bytes ? decodeSysctlString(bytes) : undefined;
  },
  sysctlBytes: sysctlRaw,
  vmStatistics() {
    const l = open();
    if (!l) return undefined;
    const info = new Uint8Array(VM_STATISTICS64_BYTES);
    const count = new Uint32Array([HOST_VM_INFO64_COUNT]);
    if (l.host_statistics64(host(l), HOST_VM_INFO64, ptr(info), ptr(count)) !== KERN_SUCCESS) return undefined;
    return parseVmStatistics64(info);
  },
  processorSetLoad() {
    const l = open();
    if (!l) return undefined;
    if (psetPort === 0) {
      const out = new Uint32Array(1);
      if (l.processor_set_default(host(l), ptr(out)) !== KERN_SUCCESS) return undefined;
      psetPort = out[0]!;
    }
    const info = new Int32Array(PROCESSOR_SET_LOAD_INFO_COUNT);
    const count = new Uint32Array([PROCESSOR_SET_LOAD_INFO_COUNT]);
    if (l.processor_set_statistics(psetPort, PROCESSOR_SET_LOAD_INFO, ptr(info), ptr(count)) !== KERN_SUCCESS) {
      // Re-ask next time rather than failing forever on a right that went stale.
      psetPort = 0;
      return undefined;
    }
    return { taskCount: info[0]!, threadCount: info[1]! };
  },
};

/** The real kernel on darwin, null everywhere else — so a caller on another
 *  platform never reaches a symbol, and says so with one check. */
export function darwinKernel(): DarwinKernel | null {
  return open() ? realKernel : null;
}

/**
 * The CPU, not the process: `hw.optional.arm64` is 1 on Apple Silicon even for an
 * x64 build of Bun running under Rosetta, where `process.arch` says "x64" while
 * every sensor, core and cache belongs to an M-series chip.
 */
export function isAppleSilicon(kernel: DarwinKernel | null = darwinKernel()): boolean {
  return kernel?.sysctlNumber("hw.optional.arm64") === 1;
}
