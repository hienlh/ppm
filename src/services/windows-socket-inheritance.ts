/**
 * Keep child processes from inheriting this process's sockets (and other stray handles) on Windows.
 *
 * Bun 1.3.10 on Windows creates every socket inheritable — the `Bun.serve` listener, each
 * connection it accepts, `fetch`'s outgoing connections — and `Bun.spawn` (which
 * `node:child_process` goes through, so the Agent SDK's Claude CLI, codex, git and the rest
 * all do) creates its children with handle inheritance on. Every child therefore got a copy
 * of every socket the process had open at that moment. Measured: a child listed the server's
 * listener and both accepted connections by address, and connections the server had closed
 * sent no FIN until that child exited — `closesocket` drops one handle of several. A browser,
 * still holding what looked like a live keep-alive connection, sent its next request into it
 * and waited: a reload after the server spawned a long-lived child took 44s instead of 75ms.
 * Inherited handles stay inheritable, so they also pass on to grandchildren.
 *
 * Making the listener non-inheritable is not enough: an accepted socket does not take the
 * flag from the listener, it is created inheritable again. And Bun offers no way to spawn with
 * a restricted handle list. So every spawn first clears `HANDLE_FLAG_INHERIT` on every handle
 * this process holds except the three standard ones (`clearInheritableHandles`), done by
 * wrapping `Bun.spawn` and `Bun.spawnSync` once at startup (`installSpawnHandleGuard`). A child
 * still gets the stdio it was given: libuv duplicates those handles as inheritable inside the
 * spawn call itself, after this has run.
 *
 * Why every handle and not just sockets: telling a socket apart means asking about the object
 * (`getsockopt`, `GetFileType`, `NtQueryObject`), and each of those waits on the file object's
 * lock — measured: `getsockopt` on an inheritable synchronous pipe that another thread was
 * blocked reading never returned. Clearing the flag is a handle-table operation that touches no
 * object, and nothing in PPM passes a handle to a child by plain inheritance. What it cannot
 * cover is a spawn from a Worker (its `Bun` is not wrapped, and one running during a sweep could
 * lose its stdio); PPM spawns only from the main thread. `Bun.$` does not go through `Bun.spawn`.
 * Off Windows everything here is a no-op.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";

/** `NtQueryInformationProcess` class returning the calling process's own handle table. */
const PROCESS_HANDLE_INFORMATION = 51;
const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004;
const STATUS_BUFFER_OVERFLOW = 0x80000005;
const STATUS_BUFFER_TOO_SMALL = 0xc0000023;
/** `PROCESS_HANDLE_SNAPSHOT_INFORMATION`: two ULONG_PTR, then 40-byte entries on x64. */
const SNAPSHOT_HEADER = 16;
const ENTRY_SIZE = 40;
const ENTRY_ATTRIBUTES_OFFSET = 32;
const OBJ_INHERIT = 0x2;
const HANDLE_FLAG_INHERIT = 0x1;
/** `(HANDLE)-1`, the pseudo handle for the calling process. */
const CURRENT_PROCESS = -1n;
/** `STD_INPUT_HANDLE`, `STD_OUTPUT_HANDLE`, `STD_ERROR_HANDLE` as DWORDs. */
const STD_HANDLE_IDS = [-10 >>> 0, -11 >>> 0, -12 >>> 0];

type Native = {
  NtQueryInformationProcess: (process: bigint, cls: number, info: number, size: number, ret: number) => number;
  SetHandleInformation: (handle: bigint, mask: number, flags: number) => number;
  GetStdHandle: (id: number) => bigint | number;
};

let native: Native | null | undefined;
/** Reused across sweeps; grows when the handle table outgrows it. */
let snapshot = new BigUint64Array(64 * 1024 / 8);

function load(): Native | null {
  if (native !== undefined) return native;
  try {
    const nt = dlopen("ntdll.dll", {
      NtQueryInformationProcess: { args: [FFIType.i64, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    }).symbols;
    const k32 = dlopen("kernel32.dll", {
      SetHandleInformation: { args: [FFIType.u64, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
      GetStdHandle: { args: [FFIType.u32], returns: FFIType.u64 },
    }).symbols;
    native = { ...nt, ...k32 } as unknown as Native;
  } catch {
    native = null;
  }
  return native;
}

/** This process's handles that a child would inherit, as raw handle values. */
function inheritableHandles(n: Native): bigint[] {
  const returned = new Uint32Array(1);
  for (let attempt = 0; attempt < 4; attempt++) {
    const status = n.NtQueryInformationProcess(
      CURRENT_PROCESS, PROCESS_HANDLE_INFORMATION, ptr(snapshot), snapshot.byteLength, ptr(returned),
    ) >>> 0;
    if (status === STATUS_INFO_LENGTH_MISMATCH || status === STATUS_BUFFER_OVERFLOW || status === STATUS_BUFFER_TOO_SMALL) {
      const want = Math.max(snapshot.byteLength * 2, returned[0]! + 4096);
      snapshot = new BigUint64Array(Math.ceil(want / 8));
      continue;
    }
    if (status !== 0) return [];
    const view = new DataView(snapshot.buffer);
    const count = Number(view.getBigUint64(0, true));
    const out: bigint[] = [];
    for (let i = 0; i < count; i++) {
      const at = SNAPSHOT_HEADER + i * ENTRY_SIZE;
      if (at + ENTRY_SIZE > snapshot.byteLength) break;
      if (view.getUint32(at + ENTRY_ATTRIBUTES_OFFSET, true) & OBJ_INHERIT) out.push(view.getBigUint64(at, true));
    }
    return out;
  }
  return [];
}

/**
 * Clear the inherit flag on every handle this process holds except stdin, stdout and stderr.
 * Returns how many were cleared; 0 off Windows or when the calls are unavailable. Never throws.
 */
export function clearInheritableHandles(platform: NodeJS.Platform = process.platform): number {
  if (platform !== "win32") return 0;
  try {
    const n = load();
    if (!n) return 0;
    const std = new Set(STD_HANDLE_IDS.map((id) => BigInt(n.GetStdHandle(id))));
    let cleared = 0;
    for (const handle of inheritableHandles(n)) {
      if (std.has(handle)) continue;
      if (n.SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) !== 0) cleared++;
    }
    return cleared;
  } catch {
    return 0;
  }
}

const GUARD = Symbol.for("ppm.spawnHandleGuard");

/**
 * Wrap `Bun.spawn` and `Bun.spawnSync` so each spawn first clears the inherit flag on this
 * process's handles. `node:child_process` calls them at spawn time, so it is covered too.
 * Idempotent; returns whether the guard is in place (always false off Windows).
 */
export function installSpawnHandleGuard(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return false;
  const bun = Bun as unknown as Record<PropertyKey, unknown>;
  if (bun[GUARD]) return true;
  if (!load()) return false;
  const spawn = Bun.spawn as (...args: unknown[]) => unknown;
  const spawnSync = Bun.spawnSync as (...args: unknown[]) => unknown;
  bun.spawn = function (this: unknown, ...args: unknown[]) {
    clearInheritableHandles();
    return spawn.apply(this, args);
  };
  bun.spawnSync = function (this: unknown, ...args: unknown[]) {
    clearInheritableHandles();
    return spawnSync.apply(this, args);
  };
  bun[GUARD] = true;
  return true;
}
