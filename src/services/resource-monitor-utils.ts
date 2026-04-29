/**
 * Pure utility functions for resource monitoring:
 * ps output parsing, process tree building, and categorization.
 */

import type { ProcessEntry, ResourceGroup } from "./resource-monitor.service.ts";

// ── Categorization patterns ────────────────────────────────────────────

const CATEGORY_PATTERNS: [ResourceGroup["type"], RegExp][] = [
  ["terminal", /^(bash|zsh|sh|fish|csh|tcsh|dash|ksh|pwsh|powershell)$/i],
  ["ai-tool", /^(claude|anthropic)/i],
  ["build", /^(node|bun|tsc|vite|webpack|esbuild|turbo|rollup|swc)$/i],
];

function categorize(cmd: string): ResourceGroup["type"] {
  const basename = cmd.split("/").pop()?.split(" ")[0] ?? cmd;
  for (const [type, re] of CATEGORY_PATTERNS) {
    if (re.test(basename)) return type;
  }
  return "unknown";
}

// ── Parser ─────────────────────────────────────────────────────────────

/** Parse `ps -e -o pid,ppid,%cpu,rss,args` output into structured entries */
export function parseProcessList(stdout: string): ProcessEntry[] {
  const lines = stdout.trim().split("\n");
  if (lines.length < 2) return [];

  const entries: ProcessEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 5) continue;

    const pid = parseInt(parts[0]!, 10);
    const ppid = parseInt(parts[1]!, 10);
    const cpu = parseFloat(parts[2]!);
    const rssKB = parseInt(parts[3]!, 10);
    const command = parts.slice(4).join(" ");

    if (isNaN(pid) || pid === 0 || !command) continue;

    entries.push({
      pid,
      ppid,
      cpu: Math.round(cpu * 10) / 10,
      ramMB: Math.round((rssKB / 1024) * 10) / 10,
      command,
    });
  }
  return entries;
}

// ── Tree builder ───────────────────────────────────────────────────────

/** Build flat list of all descendants of rootPid via ppid traversal */
export function buildTree(entries: ProcessEntry[], rootPid: number): ProcessEntry[] {
  const childMap = new Map<number, ProcessEntry[]>();
  for (const e of entries) {
    const list = childMap.get(e.ppid) ?? [];
    list.push(e);
    childMap.set(e.ppid, list);
  }

  const result: ProcessEntry[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    const children = childMap.get(pid) ?? [];
    for (const child of children) {
      result.push(child);
      queue.push(child.pid);
    }
  }
  return result;
}

// ── Grouping ───────────────────────────────────────────────────────────

const TYPE_LABELS: Record<ResourceGroup["type"], string> = {
  server: "PPM Server",
  terminal: "Terminals",
  "ai-tool": "AI Tools",
  build: "Build Tools",
  unknown: "Other",
};

/** Group processes into resource groups by category */
export function groupProcesses(
  serverEntry: ProcessEntry | undefined,
  children: ProcessEntry[],
): ResourceGroup[] {
  const groups: ResourceGroup[] = [];

  if (serverEntry) {
    groups.push({
      type: "server",
      label: "PPM Server",
      cpu: serverEntry.cpu,
      ramMB: serverEntry.ramMB,
      processes: [{ pid: serverEntry.pid, cpu: serverEntry.cpu, ramMB: serverEntry.ramMB, command: serverEntry.command }],
    });
  }

  const buckets = new Map<ResourceGroup["type"], ProcessEntry[]>();
  for (const child of children) {
    const type = categorize(child.command);
    const list = buckets.get(type) ?? [];
    list.push(child);
    buckets.set(type, list);
  }

  for (const type of ["terminal", "ai-tool", "build", "unknown"] as const) {
    const procs = buckets.get(type);
    if (!procs?.length) continue;
    groups.push({
      type,
      label: TYPE_LABELS[type],
      cpu: Math.round(procs.reduce((s, p) => s + p.cpu, 0) * 10) / 10,
      ramMB: Math.round(procs.reduce((s, p) => s + p.ramMB, 0) * 10) / 10,
      processes: procs.map((p) => ({ pid: p.pid, cpu: p.cpu, ramMB: p.ramMB, command: p.command })),
    });
  }

  return groups;
}
