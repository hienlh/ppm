/**
 * How much memory every process below this one holds, read from the OS.
 *
 * The monitor's own numbers cover one process, and on 26/10/2026 that was the smaller half:
 * the server held 7 GB while its 17 Claude subprocesses held 11 GB between them, and nothing
 * PPM logged could say so. The spawn tracker only sees direct children, and only the ones
 * started after it was installed; the OS sees the whole tree, grandchildren included (an MCP
 * server under a Claude subprocess, a test runner under a shell).
 *
 * Windows reads every process with one `NtQuerySystemInformation` call (the same one
 * `process-thread-snapshot.ts` makes); Linux walks `/proc`. Other platforms answer null.
 * Nothing here throws.
 */
import { readdirSync, readFileSync } from "node:fs";
import { querySystemProcessInformation } from "./process-thread-snapshot.ts";

export interface ProcessMemoryEntry {
  pid: number;
  ppid: number;
  /** Image name, lowercased, executable extension dropped. */
  name: string;
  privateMB: number;
  /** When the process started, ms since the epoch on Windows and since boot on Linux: only compared, never shown. */
  startedAt: number;
}

const MB = 1024 * 1024;

// SYSTEM_PROCESS_INFORMATION on 64-bit Windows.
const P_NEXT = 0x00;
const P_CREATE_TIME = 0x20;
const P_IMAGE_NAME_LENGTH = 0x38;
const P_IMAGE_NAME_BUFFER = 0x40;
const P_PID = 0x50;
const P_PARENT_PID = 0x58;
const P_PRIVATE_BYTES = 0xc8;
const P_SIZE = 0x100;
/** 100 ns ticks between 1601-01-01 and 1970-01-01. */
const EPOCH_TICKS = 116_444_736_000_000_000n;

export function processName(raw: string): string {
  return raw.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "").slice(0, 40) || "unknown";
}

/** Every process in a `SystemProcessInformation` buffer. Exported for tests. */
export function parseWindowsProcessList(view: DataView, base: bigint): ProcessMemoryEntry[] {
  const out: ProcessMemoryEntry[] = [];
  let at = 0;
  for (;;) {
    if (at + P_SIZE > view.byteLength) break;
    const pid = Number(view.getBigUint64(at + P_PID, true));
    let name = pid === 0 ? "idle" : "system";
    const nameBytes = view.getUint16(at + P_IMAGE_NAME_LENGTH, true);
    const namePtr = view.getBigUint64(at + P_IMAGE_NAME_BUFFER, true);
    const offset = Number(namePtr - base);
    if (nameBytes > 0 && offset >= 0 && offset + nameBytes <= view.byteLength) {
      name = new TextDecoder("utf-16le").decode(new Uint8Array(view.buffer, view.byteOffset + offset, nameBytes));
    }
    const created = view.getBigInt64(at + P_CREATE_TIME, true);
    out.push({
      pid,
      ppid: Number(view.getBigUint64(at + P_PARENT_PID, true)),
      name: processName(name),
      privateMB: Math.round(Number(view.getBigUint64(at + P_PRIVATE_BYTES, true)) / MB),
      startedAt: created > EPOCH_TICKS ? Number((created - EPOCH_TICKS) / 10_000n) : 0,
    });
    const next = view.getUint32(at + P_NEXT, true);
    if (next === 0) break;
    at += next;
  }
  return out;
}

/** `/proc/<pid>/stat` → ppid, name and start time (field 22, clock ticks since boot). Exported for tests. */
export function parseLinuxStatLine(text: string): { ppid: number; name: string; startedAt: number } | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open === -1 || close === -1) return null;
  const f = text.slice(close + 2).trim().split(/\s+/);
  const ppid = Number(f[4 - 3]);
  const startedAt = Number(f[22 - 3]);
  if (!Number.isFinite(ppid)) return null;
  return { ppid, name: processName(text.slice(open + 1, close)), startedAt: Number.isFinite(startedAt) ? startedAt : 0 };
}

function linuxPrivateMB(pid: number): number {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const kb = (key: string) => Number(status.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1] ?? 0);
    return Math.round((kb("RssAnon") + kb("VmSwap")) / 1024);
  } catch {
    return 0;
  }
}

function readLinuxList(rootPid: number): ProcessMemoryEntry[] {
  const all: ProcessMemoryEntry[] = [];
  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);
    if (!Number.isInteger(pid)) continue;
    try {
      const stat = parseLinuxStatLine(readFileSync(`/proc/${pid}/stat`, "utf8"));
      if (stat) all.push({ pid, ...stat, privateMB: 0 });
    } catch { /* exited while walking */ }
  }
  // Memory only for the tree that is reported: one status read per descendant, not per process.
  const tree = new Set(descendantsOf(rootPid, all).map((d) => d.pid));
  for (const p of all) if (tree.has(p.pid) || p.pid === rootPid) p.privateMB = linuxPrivateMB(p.pid);
  return all;
}

/** Every process the OS lists, or null when this platform cannot be read. */
export async function readProcessList(rootPid = process.pid, platform: NodeJS.Platform = process.platform): Promise<ProcessMemoryEntry[] | null> {
  try {
    if (platform === "win32") {
      const info = await querySystemProcessInformation();
      return info ? parseWindowsProcessList(info.view, info.base) : null;
    }
    if (platform === "linux") return readLinuxList(rootPid);
  } catch { /* fall through */ }
  return null;
}

export interface Descendant extends ProcessMemoryEntry {
  depth: number;
  /** The direct child of the root this process descends from (itself, at depth 1). */
  branchPid: number;
}

/**
 * Every process below `rootPid`. A process counts as a child only if it started after its
 * parent: Windows reuses pids, so a ppid can name an unrelated process that took a dead
 * parent's number, and without the check that process's whole tree would be claimed.
 */
export function descendantsOf(rootPid: number, list: ProcessMemoryEntry[]): Descendant[] {
  const byParent = new Map<number, ProcessMemoryEntry[]>();
  const byPid = new Map<number, ProcessMemoryEntry>();
  for (const p of list) {
    byPid.set(p.pid, p);
    if (p.pid === p.ppid) continue;
    const siblings = byParent.get(p.ppid);
    if (siblings) siblings.push(p); else byParent.set(p.ppid, [p]);
  }
  const out: Descendant[] = [];
  const queue: Array<{ p: ProcessMemoryEntry; depth: number; branchPid: number }> = [];
  const root = byPid.get(rootPid);
  for (const c of byParent.get(rootPid) ?? []) {
    if (!root || c.startedAt >= root.startedAt) queue.push({ p: c, depth: 1, branchPid: c.pid });
  }
  const seen = new Set<number>([rootPid]);
  while (queue.length) {
    const { p, depth, branchPid } = queue.shift()!;
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    out.push({ ...p, depth, branchPid });
    for (const c of byParent.get(p.pid) ?? []) {
      if (c.startedAt >= p.startedAt) queue.push({ p: c, depth: depth + 1, branchPid });
    }
  }
  return out;
}
