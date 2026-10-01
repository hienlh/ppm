/**
 * Per-process disk bytes on macOS: `proc_pid_rusage(pid, RUSAGE_INFO_V2)`, read
 * over FFI at ~3 µs a process (676 processes in 2 ms on an M1 Max). The counters
 * are physical I/O, like Linux's `read_bytes`/`write_bytes` in `/proc/<pid>/io`:
 * a 32 MiB fsynced write moved `ri_diskio_byteswritten` by exactly 32 MiB.
 *
 * macOS answers only for the caller's own user. Another user's process — launchd,
 * WindowServer, every daemon — is EPERM, which stays `undefined` (an em dash in
 * the table), never a confident 0.
 */
import { dlopen, FFIType as T, ptr } from "bun:ffi";

const LIBSYSTEM = "/usr/lib/libSystem.B.dylib";
/** `<sys/resource.h>`: the flavor, and `sizeof(struct rusage_info_v2)`. */
export const RUSAGE_INFO_V2 = 2;
export const RUSAGE_INFO_V2_BYTES = 160;
/** `ri_diskio_bytesread` and `ri_diskio_byteswritten`, the struct's last two u64s. */
const BYTES_READ_OFFSET = 144;
const BYTES_WRITTEN_OFFSET = 152;

export interface ProcessDiskIo {
  readBytes: number;
  writeBytes: number;
}

/** Cumulative disk bytes of one process; undefined where macOS refuses it. */
export type DarwinProcessDiskIo = (pid: number) => ProcessDiskIo | undefined;

export function parseRusageDiskIo(bytes: Uint8Array): ProcessDiskIo | undefined {
  if (bytes.byteLength < RUSAGE_INFO_V2_BYTES) return undefined;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    readBytes: Number(v.getBigUint64(BYTES_READ_OFFSET, true)),
    writeBytes: Number(v.getBigUint64(BYTES_WRITTEN_OFFSET, true)),
  };
}

type ProcPidRusage = (pid: number, flavor: number, buffer: number) => number;

/** `undefined` until first asked for; `null` where libSystem cannot be opened. */
let procPidRusage: ProcPidRusage | null | undefined;
const buffer = new Uint8Array(RUSAGE_INFO_V2_BYTES);

function open(): ProcPidRusage | null {
  if (procPidRusage !== undefined) return procPidRusage;
  procPidRusage = null;
  if (process.platform !== "darwin") return null;
  try {
    const lib = dlopen(LIBSYSTEM, { proc_pid_rusage: { args: [T.i32, T.i32, T.ptr], returns: T.i32 } });
    procPidRusage = lib.symbols.proc_pid_rusage as unknown as ProcPidRusage;
  } catch {
    procPidRusage = null;
  }
  return procPidRusage;
}

/** One buffer for every call: the caller reads it out before the next one. */
export const darwinProcessDiskIo: DarwinProcessDiskIo = (pid) => {
  const call = open();
  if (!call || call(pid, RUSAGE_INFO_V2, ptr(buffer)) !== 0) return undefined;
  return parseRusageDiskIo(buffer);
};
