/**
 * What another process's main thread is doing right now, read from outside it.
 *
 * When the server stops answering, nothing inside it can say why: its event loop is
 * the thing that stopped. The supervisor can still look, and one reading taken while
 * the health probe is timing out names the wait — `WrPageIn` (memory being read back
 * from disk), `Executive` (a kernel wait such as a synchronous file read), `WrQueue`
 * (idle, so the loop is fine and the probe was slow elsewhere), or running (our own
 * synchronous work). That one word is what located the 20-60s stalls of 26/10/2026,
 * which were invisible to every log PPM kept: an outside watcher found the main
 * thread in `PageIn` for 23s with the machine at 13% CPU.
 *
 * Also returned: the process's hard page faults and CPU time, so two readings give a
 * rate. Windows reads all of it with one `NtQuerySystemInformation` call; Linux reads
 * `/proc/<pid>/stat` and the main task's `wchan`. Every field is `undefined` when it
 * cannot be read, and nothing here throws.
 */
import { readFileSync } from "node:fs";

export interface ThreadSnapshot {
  /** Main thread scheduler state: "running", "waiting", "ready", … (Linux: R, S, D, … spelled out). */
  state?: string;
  /** Windows `KWAIT_REASON` name while waiting; Linux `wchan` (the kernel function it sleeps in). */
  waitReason?: string;
  threads?: number;
  /** Page faults that went to disk, since the process started. */
  hardFaults?: number;
  /** User + kernel CPU of the whole process since it started, in ms. */
  cpuMs?: number;
}

const THREAD_STATES = [
  "initialized", "ready", "running", "standby", "terminated", "waiting", "transition",
  "deferred-ready", "gate-wait", "waiting-for-outswap",
];

/** `KWAIT_REASON`, in order. */
const WAIT_REASONS = [
  "Executive", "FreePage", "PageIn", "PoolAllocation", "DelayExecution", "Suspended", "UserRequest",
  "WrExecutive", "WrFreePage", "WrPageIn", "WrPoolAllocation", "WrDelayExecution", "WrSuspended",
  "WrUserRequest", "WrSpare0", "WrQueue", "WrLpcReceive", "WrLpcReply", "WrVirtualMemory", "WrPageOut",
  "WrRendezvous", "WrKeyedEvent", "WrTerminated", "WrProcessInSwap", "WrCpuRateControl",
  "WrCalloutStack", "WrKernel", "WrResource", "WrPushLock", "WrMutex", "WrQuantumEnd",
  "WrDispatchInt", "WrPreempted", "WrYieldExecution", "WrFastMutex", "WrGuardedMutex", "WrRundown",
  "WrAlertByThreadId", "WrDeferredPreempt", "WrPhysicalFault",
];

// SYSTEM_PROCESS_INFORMATION on 64-bit Windows.
const P_NEXT = 0x00;
const P_THREADS = 0x04;
const P_HARD_FAULTS = 0x10;
const P_USER_TIME = 0x28;
const P_KERNEL_TIME = 0x30;
const P_PID = 0x50;
const P_SIZE = 0x100;
// SYSTEM_THREAD_INFORMATION, which follow it one after another.
const T_CREATE_TIME = 0x10;
const T_STATE = 0x44;
const T_WAIT_REASON = 0x48;
const T_SIZE = 0x50;
/** Process and thread times are in 100 ns units. */
const TICKS_PER_MS = 10_000n;

/**
 * Find `pid` in a `SystemProcessInformation` buffer and describe its main thread — the
 * one created first. Exported for tests.
 */
export function parseWindowsProcessInformation(view: DataView, pid: number): ThreadSnapshot | null {
  let at = 0;
  for (;;) {
    if (at + P_SIZE > view.byteLength) return null;
    if (Number(view.getBigUint64(at + P_PID, true)) === pid) {
      const threads = view.getUint32(at + P_THREADS, true);
      const cpu = view.getBigInt64(at + P_USER_TIME, true) + view.getBigInt64(at + P_KERNEL_TIME, true);
      const out: ThreadSnapshot = {
        threads,
        hardFaults: view.getUint32(at + P_HARD_FAULTS, true),
        cpuMs: Number(cpu / TICKS_PER_MS),
      };
      let main = -1;
      let mainCreated = 0n;
      for (let i = 0; i < threads; i++) {
        const t = at + P_SIZE + i * T_SIZE;
        if (t + T_SIZE > view.byteLength) break;
        const created = view.getBigInt64(t + T_CREATE_TIME, true);
        if (main === -1 || created < mainCreated) { main = t; mainCreated = created; }
      }
      if (main !== -1) {
        const state = view.getUint32(main + T_STATE, true);
        out.state = THREAD_STATES[state] ?? `state-${state}`;
        if (out.state === "waiting") {
          const reason = view.getUint32(main + T_WAIT_REASON, true);
          out.waitReason = WAIT_REASONS[reason] ?? `reason-${reason}`;
        }
      }
      return out;
    }
    const next = view.getUint32(at + P_NEXT, true);
    if (next === 0) return null;
    at += next;
  }
}

type Ntdll = { NtQuerySystemInformation: (cls: number, buf: number, len: number, ret: number) => number };
let ntdll: Ntdll | null | undefined;

const SYSTEM_PROCESS_INFORMATION = 5;
const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004 | 0;
/** Grows on a length mismatch; a busy machine needs ~1-2 MB. */
let bufferSize = 2 * 1024 * 1024;

async function readWindows(pid: number): Promise<ThreadSnapshot | null> {
  if (ntdll === undefined) {
    try {
      const { dlopen, FFIType } = await import("bun:ffi");
      ntdll = dlopen("ntdll.dll", {
        NtQuerySystemInformation: { args: [FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
      }).symbols as unknown as Ntdll;
    } catch {
      ntdll = null;
    }
  }
  if (!ntdll) return null;
  const { ptr } = await import("bun:ffi");
  for (let attempt = 0; attempt < 4; attempt++) {
    const buf = new Uint8Array(bufferSize);
    const needed = new Uint32Array(1);
    const status = ntdll.NtQuerySystemInformation(SYSTEM_PROCESS_INFORMATION, ptr(buf), buf.byteLength, ptr(needed));
    if (status === STATUS_INFO_LENGTH_MISMATCH) {
      bufferSize = Math.max(bufferSize * 2, (needed[0] ?? 0) + 256 * 1024);
      continue;
    }
    if (status !== 0) return null;
    return parseWindowsProcessInformation(new DataView(buf.buffer), pid);
  }
  return null;
}

const LINUX_STATES: Record<string, string> = {
  R: "running", S: "sleeping", D: "disk-wait", T: "stopped", t: "traced", Z: "zombie", X: "dead",
  I: "idle", W: "paging", P: "parked",
};

/** `/proc/<pid>/stat`: state, threads, major faults, CPU. Exported for tests. */
export function parseLinuxStat(text: string, clockTicksPerSecond = 100): ThreadSnapshot | null {
  // The command name is in parentheses and may itself hold spaces or parentheses.
  const close = text.lastIndexOf(")");
  if (close === -1) return null;
  const f = text.slice(close + 2).trim().split(/\s+/);
  // f[0] is field 3 (state); field N is f[N - 3].
  const state = f[0];
  const majflt = Number(f[12 - 3]);
  const utime = Number(f[14 - 3]);
  const stime = Number(f[15 - 3]);
  const threads = Number(f[20 - 3]);
  const out: ThreadSnapshot = {};
  if (state) out.state = LINUX_STATES[state] ?? state;
  if (Number.isFinite(majflt)) out.hardFaults = majflt;
  if (Number.isFinite(utime) && Number.isFinite(stime)) out.cpuMs = Math.round(((utime + stime) * 1000) / clockTicksPerSecond);
  if (Number.isFinite(threads)) out.threads = threads;
  return out;
}

function readLinux(pid: number): ThreadSnapshot | null {
  const out = parseLinuxStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
  if (!out) return null;
  // The process's own stat reports the main task's state; wchan says where it sleeps.
  try {
    const wchan = readFileSync(`/proc/${pid}/task/${pid}/wchan`, "utf8").trim();
    if (wchan && wchan !== "0") out.waitReason = wchan;
  } catch { /* wchan is optional, and hidden on some kernels */ }
  return out;
}

/** One reading of `pid`. Null when the platform cannot be read or the process is gone. */
export async function readThreadSnapshot(pid: number, platform: NodeJS.Platform = process.platform): Promise<ThreadSnapshot | null> {
  try {
    if (platform === "win32") return await readWindows(pid);
    if (platform === "linux") return readLinux(pid);
  } catch { /* fall through */ }
  return null;
}

/** "main thread waiting/WrPageIn, hard faults +38, cpu +120ms" — relative to `previous` when given. */
export function describeThreadSnapshot(now: ThreadSnapshot, previous?: ThreadSnapshot | null): string {
  const parts: string[] = [];
  if (now.state) parts.push(`main thread ${now.state}${now.waitReason ? `/${now.waitReason}` : ""}`);
  if (now.hardFaults !== undefined) {
    parts.push(previous?.hardFaults !== undefined ? `hard faults +${now.hardFaults - previous.hardFaults}` : `hard faults ${now.hardFaults}`);
  }
  if (now.cpuMs !== undefined && previous?.cpuMs !== undefined) parts.push(`server cpu +${now.cpuMs - previous.cpuMs}ms`);
  return parts.join(", ");
}
