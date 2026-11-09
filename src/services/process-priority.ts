/**
 * This process's CPU, memory and I/O priority on Windows, and raising them back to normal.
 *
 * A process started by a Task Scheduler task at the default priority 7 — which is how
 * PPM's autostart task was registered until it was changed to 5 — runs below normal on
 * CPU, at memory priority 2 instead of 5, and at I/O priority Low instead of Normal.
 * Every child inherits that, the server included. Windows takes pages from a
 * low-memory-priority process first, and reading them back happens at that process's
 * I/O priority. Measured on 26/10/2026: the server's main thread sat in `PageIn` waits
 * for 23s on an idle NVMe disk with the machine at 13% CPU, and stalls like it, 20-60s
 * long and several an hour, were what the supervisor's health check kept killing it for.
 * Raising the three priorities to normal on the running process needs no privilege.
 *
 * Only ever raises: a priority someone set higher on purpose is left alone.
 * Every read is `undefined` when it fails, and nothing here throws.
 */

export interface ProcessPriority {
  /** Priority class name, e.g. "normal", "below-normal". */
  cpu?: string;
  /** Memory priority, 1 (very low) to 5 (normal). */
  memory?: number;
  /** I/O priority, 0 (very low) to 2 (normal); 3 is high. */
  io?: number;
}

const CLASS_NAMES: Record<number, string> = {
  0x40: "idle",
  0x4000: "below-normal",
  0x20: "normal",
  0x8000: "above-normal",
  0x80: "high",
  0x100: "realtime",
};
const NORMAL_PRIORITY_CLASS = 0x20;
/** Classes below normal, the only ones this raises. */
const LOW_CLASSES = new Set(["idle", "below-normal"]);
export const MEMORY_PRIORITY_NORMAL = 5;
export const IO_PRIORITY_NORMAL = 2;

/** `GetProcessInformation` / `SetProcessInformation` class. */
const PROCESS_MEMORY_PRIORITY = 0;
/** `NtQueryInformationProcess` / `NtSetInformationProcess` class `ProcessIoPriority`. */
const PROCESS_IO_PRIORITY = 33;
/** `(HANDLE)-1`, the pseudo handle for the calling process. */
const CURRENT_PROCESS = -1n;

/** What to change to bring `p` up to normal; an empty object when nothing is below it. Exported for tests. */
export function priorityRaisePlan(p: ProcessPriority): { cpu?: true; memory?: true; io?: true } {
  const plan: { cpu?: true; memory?: true; io?: true } = {};
  if (p.cpu !== undefined && LOW_CLASSES.has(p.cpu)) plan.cpu = true;
  if (p.memory !== undefined && p.memory < MEMORY_PRIORITY_NORMAL) plan.memory = true;
  if (p.io !== undefined && p.io < IO_PRIORITY_NORMAL) plan.io = true;
  return plan;
}

/** "cpu=below-normal memory=2/5 io=1/2", for one log line. */
export function describePriority(p: ProcessPriority): string {
  const v = (x: unknown) => (x === undefined ? "?" : String(x));
  return `cpu=${v(p.cpu)} memory=${v(p.memory)}/${MEMORY_PRIORITY_NORMAL} io=${v(p.io)}/${IO_PRIORITY_NORMAL}`;
}

type Kernel32 = {
  GetPriorityClass: (process: bigint) => number;
  SetPriorityClass: (process: bigint, cls: number) => number;
  GetProcessInformation: (process: bigint, cls: number, info: number, size: number) => number;
  SetProcessInformation: (process: bigint, cls: number, info: number, size: number) => number;
};
type Ntdll = {
  NtQueryInformationProcess: (process: bigint, cls: number, info: number, size: number, ret: number | null) => number;
  NtSetInformationProcess: (process: bigint, cls: number, info: number, size: number) => number;
};

let libs: { k32: Kernel32; nt: Ntdll } | null | undefined;

async function load(): Promise<{ k32: Kernel32; nt: Ntdll } | null> {
  if (libs !== undefined) return libs;
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const k32 = dlopen("kernel32.dll", {
      GetPriorityClass: { args: [FFIType.i64], returns: FFIType.u32 },
      SetPriorityClass: { args: [FFIType.i64, FFIType.u32], returns: FFIType.i32 },
      GetProcessInformation: { args: [FFIType.i64, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      SetProcessInformation: { args: [FFIType.i64, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    }).symbols as unknown as Kernel32;
    const nt = dlopen("ntdll.dll", {
      NtQueryInformationProcess: { args: [FFIType.i64, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
      NtSetInformationProcess: { args: [FFIType.i64, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    }).symbols as unknown as Ntdll;
    libs = { k32, nt };
  } catch {
    libs = null;
  }
  return libs;
}

/** This process's priorities. Empty off Windows or when the calls are unavailable. */
export async function readProcessPriority(platform: NodeJS.Platform = process.platform): Promise<ProcessPriority> {
  if (platform !== "win32") return {};
  try {
    const l = await load();
    if (!l) return {};
    const { ptr } = await import("bun:ffi");
    const out: ProcessPriority = {};
    const cls = l.k32.GetPriorityClass(CURRENT_PROCESS);
    if (cls) out.cpu = CLASS_NAMES[cls] ?? `0x${cls.toString(16)}`;
    const mem = new Uint32Array(1);
    if (l.k32.GetProcessInformation(CURRENT_PROCESS, PROCESS_MEMORY_PRIORITY, ptr(mem), 4) !== 0) out.memory = mem[0];
    const io = new Uint32Array(1);
    if (l.nt.NtQueryInformationProcess(CURRENT_PROCESS, PROCESS_IO_PRIORITY, ptr(io), 4, null) === 0) out.io = io[0];
    return out;
  } catch {
    return {};
  }
}

/**
 * Raise whatever is below normal to normal. Returns the reading before and after, so the
 * caller can log what it found — a below-normal reading is the evidence, whether or not
 * the raise worked.
 */
export async function raiseToNormalPriority(
  platform: NodeJS.Platform = process.platform,
): Promise<{ before: ProcessPriority; after: ProcessPriority; changed: boolean }> {
  const before = await readProcessPriority(platform);
  const plan = priorityRaisePlan(before);
  if (!plan.cpu && !plan.memory && !plan.io) return { before, after: before, changed: false };
  try {
    const l = await load();
    if (!l) return { before, after: before, changed: false };
    const { ptr } = await import("bun:ffi");
    if (plan.cpu) l.k32.SetPriorityClass(CURRENT_PROCESS, NORMAL_PRIORITY_CLASS);
    if (plan.memory) {
      const mem = new Uint32Array([MEMORY_PRIORITY_NORMAL]);
      l.k32.SetProcessInformation(CURRENT_PROCESS, PROCESS_MEMORY_PRIORITY, ptr(mem), 4);
    }
    if (plan.io) {
      const io = new Uint32Array([IO_PRIORITY_NORMAL]);
      l.nt.NtSetInformationProcess(CURRENT_PROCESS, PROCESS_IO_PRIORITY, ptr(io), 4);
    }
  } catch { /* the reading after says what took */ }
  return { before, after: await readProcessPriority(platform), changed: true };
}

/**
 * Raise to normal and log it — only when something was below normal, since that reading
 * is the one worth keeping: it says the process ran demoted until this moment.
 */
export async function logPriorityRaise(role: string, warn: (message: string) => void): Promise<void> {
  const { before, after, changed } = await raiseToNormalPriority();
  if (!changed) return;
  warn(`${role} started below normal priority (${describePriority(before)}), raised to ${describePriority(after)}`);
}
