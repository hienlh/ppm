/**
 * The file a macOS process runs, as the kernel knows it: `proc_pidpath` over FFI,
 * ~3 µs a process (597 in 2 ms on an M1 Max). Unlike `proc_pid_rusage` it answers
 * for every user's processes, launchd and WindowServer included.
 *
 * `ps` prints argv[0] instead, which is not the same thing — see
 * `executablePath` in process-collector-darwin.ts for when each one is right.
 */
import { dlopen, FFIType as T, ptr } from "bun:ffi";

const LIBSYSTEM = "/usr/lib/libSystem.B.dylib";
/** `<sys/proc_info.h>`: PROC_PIDPATHINFO_MAXSIZE, four times MAXPATHLEN. */
const PATH_BUFFER_BYTES = 4 * 1024;

/** One process's executable path; undefined for a zombie or a pid that is gone. */
export type DarwinProcessPath = (pid: number) => string | undefined;

type ProcPidPath = (pid: number, buffer: number, size: number) => number;

/** `undefined` until first asked for; `null` where libSystem cannot be opened. */
let procPidPath: ProcPidPath | null | undefined;
const buffer = new Uint8Array(PATH_BUFFER_BYTES);
const decoder = new TextDecoder();

function open(): ProcPidPath | null {
  if (procPidPath !== undefined) return procPidPath;
  procPidPath = null;
  if (process.platform !== "darwin") return null;
  try {
    const lib = dlopen(LIBSYSTEM, { proc_pidpath: { args: [T.i32, T.ptr, T.u32], returns: T.i32 } });
    procPidPath = lib.symbols.proc_pidpath as unknown as ProcPidPath;
  } catch {
    procPidPath = null;
  }
  return procPidPath;
}

/** It returns the path's length, and 0 on failure. */
export const darwinProcessPath: DarwinProcessPath = (pid) => {
  const call = open();
  const length = call ? call(pid, ptr(buffer), buffer.byteLength) : 0;
  return length > 0 ? decoder.decode(buffer.subarray(0, length)) : undefined;
};
