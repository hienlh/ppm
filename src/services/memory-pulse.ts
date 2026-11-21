import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SystemCommit } from "./system-commit.ts";

/**
 * The server's last few memory readings, kept on disk so that whoever starts PPM after it died
 * can say what the machine looked like just before: free commit, and which chat's process tree
 * was growing. The always-on watchdog writes one per tick (every minute, every 15 s while free
 * commit is low); the file holds the last {@link MAX_SAMPLES}. It is not mem-diag: that one is
 * opt-in and tens of MB, this one is always on and a few KB.
 *
 * One file per server pid under `<ppm dir>/memory-pulse/`, because a dev and a live PPM can share
 * the folder and each supervisor must read its own dead server's file, which it finds by the pid
 * `status.json` named.
 */

export const MAX_SAMPLES = 4;
const DIR = "memory-pulse";
const STALE_MS = 24 * 60 * 60_000;

export interface PulseBranch {
  pid: number;
  name: string;
  session?: string;
  label?: string;
  treeMB: number;
}

export interface PulseSample {
  /** ms since the epoch. */
  t: number;
  commit: SystemCommit | null;
  /** The server's direct children, biggest subtree first. */
  branches: PulseBranch[];
  /** All the server's descendants together. */
  childrenMB?: number;
  /** Processes the Claude/Codex CLIs started that are not shells: their MCP servers. */
  mcpServers?: number;
}

export interface MemoryPulse {
  pid: number;
  samples: PulseSample[];
}

const pulsePath = (ppmDir: string, pid: number) => join(ppmDir, DIR, `${pid}.json`);

export function readPulse(ppmDir: string, pid: number): MemoryPulse | null {
  try {
    const data = JSON.parse(readFileSync(pulsePath(ppmDir, pid), "utf-8")) as MemoryPulse;
    if (data?.pid !== pid || !Array.isArray(data.samples)) return null;
    return data;
  } catch {
    return null;
  }
}

/** Append one sample, keeping the last {@link MAX_SAMPLES}. Never throws. */
export function writePulse(ppmDir: string, pid: number, sample: PulseSample): void {
  try {
    const dir = join(ppmDir, DIR);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const prev = readPulse(ppmDir, pid)?.samples ?? [];
    const next: MemoryPulse = { pid, samples: [...prev, sample].slice(-MAX_SAMPLES) };
    const file = pulsePath(ppmDir, pid);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(next));
    renameSync(tmp, file);
  } catch { /* a missed pulse only makes the next diagnosis vaguer */ }
}

/** Delete pulse files older than a day, except `keep`. Never throws. */
export function prunePulses(ppmDir: string, keep: ReadonlySet<number>, now = Date.now()): void {
  try {
    const dir = join(ppmDir, DIR);
    for (const name of readdirSync(dir)) {
      const pid = Number(name.replace(/\.json(\.tmp)?$/, ""));
      if (keep.has(pid)) continue;
      const file = join(dir, name);
      try {
        if (now - statSync(file).mtimeMs > STALE_MS) unlinkSync(file);
      } catch { /* gone */ }
    }
  } catch { /* no folder */ }
}

export interface Growth {
  pid: number;
  name: string;
  session?: string;
  label?: string;
  fromMB: number;
  toMB: number;
  /** Seconds between the two readings; 0 when there was only one. */
  seconds: number;
}

/**
 * The child tree that grew the most between the oldest and newest sample, or, when nothing grew,
 * the biggest one. A tree that only appeared in the newest sample counts from 0. Null with no
 * branches at all.
 *
 * Growth rather than size, because the biggest tree is usually just the chat that has been open
 * longest: on 20/11/2026 the biggest was a 7-hour-old chat at 1.4 GB, while the one that took the
 * machine over grew from 1.3 to 3.7 GB in the last 30 seconds.
 */
export function fastestGrowth(samples: readonly PulseSample[]): Growth | null {
  const last = samples[samples.length - 1];
  if (!last || last.branches.length === 0) return null;
  const first = samples.length > 1 ? samples[0]! : null;
  const seconds = first ? Math.max(0, Math.round((last.t - first.t) / 1000)) : 0;
  let best: Growth | null = null;
  for (const b of last.branches) {
    const before = first?.branches.find((x) => x.pid === b.pid)?.treeMB ?? (first ? 0 : b.treeMB);
    const g: Growth = { pid: b.pid, name: b.name, session: b.session, label: b.label, fromMB: before, toMB: b.treeMB, seconds };
    if (!best) { best = g; continue; }
    const delta = g.toMB - g.fromMB;
    const bestDelta = best.toMB - best.fromMB;
    if (delta > bestDelta || (delta === bestDelta && g.toMB > best.toMB)) best = g;
  }
  return best;
}

/** "chat session 20decca7… grew from 1256 MB to 3714 MB in 30 s", or its size when it did not grow. */
export function describeGrowth(g: Growth): string {
  const who = g.session ? `chat session ${g.session}` : `${g.label ?? g.name} (pid ${g.pid})`;
  if (g.toMB > g.fromMB && g.seconds > 0) return `${who} grew from ${g.fromMB} MB to ${g.toMB} MB in ${g.seconds} s`;
  return `${who} held ${g.toMB} MB`;
}
