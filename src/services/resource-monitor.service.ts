/**
 * Resource Monitor Service — polls `ps` to track PPM process tree,
 * categorizes processes, and maintains a ring buffer of snapshots.
 * Lazy polling: only active when SSE subscribers exist.
 */

import { parseProcessList, buildTree, groupProcesses } from "./resource-monitor-utils.ts";

// ── Types ──────────────────────────────────────────────────────────────

export interface ProcessEntry {
  pid: number;
  ppid: number;
  cpu: number;
  ramMB: number;
  command: string;
}

export interface ResourceGroup {
  type: "server" | "terminal" | "ai-tool" | "build" | "unknown";
  label: string;
  cpu: number;
  ramMB: number;
  processes: Omit<ProcessEntry, "ppid">[];
}

export interface ResourceSnapshot {
  timestamp: number;
  server: { pid: number; cpu: number; ramMB: number };
  total: { cpu: number; ramMB: number; processCount: number };
  groups: ResourceGroup[];
}

type SnapshotCallback = (snapshot: ResourceSnapshot) => void;

// ── Service ────────────────────────────────────────────────────────────

const RING_BUFFER_MAX = 600; // 30 min at 3s interval
const POLL_INTERVAL = 3000;

class ResourceMonitorService {
  private ringBuffer: ResourceSnapshot[] = [];
  private subscribers = new Set<SnapshotCallback>();
  private timer: ReturnType<typeof setInterval> | null = null;

  subscribe(cb: SnapshotCallback) {
    this.subscribers.add(cb);
    if (this.subscribers.size === 1) this.startPolling();
  }

  unsubscribe(cb: SnapshotCallback) {
    this.subscribers.delete(cb);
    if (this.subscribers.size === 0) this.stopPolling();
  }

  getLatest(): ResourceSnapshot | null {
    return this.ringBuffer.at(-1) ?? null;
  }

  getHistory(): ResourceSnapshot[] {
    return this.ringBuffer;
  }

  private startPolling() {
    if (this.timer) return;
    if (process.platform === "win32") return; // ps not available on Windows
    this.poll(); // immediate first poll
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL);
  }

  private stopPolling() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll() {
    try {
      const proc = Bun.spawn({
        cmd: ["ps", "-e", "-o", "pid,ppid,%cpu,rss,args"],
        stdout: "pipe",
        stderr: "ignore",
      });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;

      const entries = parseProcessList(stdout);
      const rootPid = process.pid;
      const serverEntry = entries.find((e) => e.pid === rootPid);
      const children = buildTree(entries, rootPid);
      const groups = groupProcesses(serverEntry, children, entries);

      const allProcs = serverEntry ? [serverEntry, ...children] : children;
      const snapshot: ResourceSnapshot = {
        timestamp: Date.now(),
        server: serverEntry
          ? { pid: serverEntry.pid, cpu: serverEntry.cpu, ramMB: serverEntry.ramMB }
          : { pid: rootPid, cpu: 0, ramMB: 0 },
        total: {
          cpu: Math.round(allProcs.reduce((s, p) => s + p.cpu, 0) * 10) / 10,
          ramMB: Math.round(allProcs.reduce((s, p) => s + p.ramMB, 0) * 10) / 10,
          processCount: allProcs.length,
        },
        groups,
      };

      this.ringBuffer.push(snapshot);
      if (this.ringBuffer.length > RING_BUFFER_MAX) {
        this.ringBuffer.shift();
      }

      for (const cb of this.subscribers) {
        try { cb(snapshot); } catch {}
      }
    } catch (err) {
      console.error("[ResourceMonitor] poll error:", err);
    }
  }
}

export const resourceMonitor = new ResourceMonitorService();
