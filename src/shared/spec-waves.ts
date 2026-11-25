/**
 * The task plan: which tasks run together.
 *
 * The AI decides the order when it writes tasks.md — `_Deps:_` for what must finish first,
 * `_Files:_` for what each task will touch. This turns that into waves (tasks in one wave run
 * at the same time, a wave starts when the previous one is done) and checks it: no loops, and
 * no two tasks of one wave touching the same file. A task that does is moved to a later wave,
 * with the reason, rather than refused, so the plan always runs.
 */
import type { SpecIssue, SpecWorkItem } from "./spec-format.ts";

export interface WavePlan {
  /** Task ids per wave, in order. Finished tasks keep their place, so the UI can show them. */
  waves: string[][];
  /** Tasks placed later than their deps alone required, and why. */
  moved: { id: string; reason: string }[];
  /** Optional tasks: never part of a run, started by hand. */
  optional: string[];
  issues: SpecIssue[];
}

/** True when two declared paths are the same file, or one is a folder holding the other. */
export function pathsOverlap(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  const dir = (p: string) => (p.endsWith("/") ? p : `${p}/`);
  return y.startsWith(dir(x)) || x.startsWith(dir(y));
}

export function sharedFiles(a: string[], b: string[]): string[] {
  return a.filter((f) => b.some((g) => pathsOverlap(f, g)));
}

export function planWaves(items: SpecWorkItem[]): WavePlan {
  const issues: SpecIssue[] = [];
  const optional = items.filter((t) => t.optional).map((t) => t.id);
  const required = items.filter((t) => !t.optional);
  const byId = new Map(required.map((t) => [t.id, t]));

  for (const t of required) {
    for (const d of t.deps) {
      if (optional.includes(d)) {
        issues.push({ line: t.line, severity: "error", message: `Task ${t.id} depends on optional task ${d}; make ${d} required or drop the dependency.` });
      }
    }
    if (t.allFiles.length === 0 && !t.done) {
      issues.push({ line: t.line, severity: "warning", message: `Task ${t.id} declares no _Files:_, so it runs on its own.` });
    }
  }

  // Topological order (Kahn); whatever is left over sits on a loop.
  const indeg = new Map(required.map((t) => [t.id, 0]));
  for (const t of required) for (const d of t.deps) if (byId.has(d)) indeg.set(t.id, indeg.get(t.id)! + 1);
  const queue = required.filter((t) => indeg.get(t.id) === 0).map((t) => t.id);
  const order: string[] = [];
  while (queue.length) {
    queue.sort(compareIds);
    const id = queue.shift()!;
    order.push(id);
    for (const t of required) {
      if (t.deps.includes(id)) {
        indeg.set(t.id, indeg.get(t.id)! - 1);
        if (indeg.get(t.id) === 0) queue.push(t.id);
      }
    }
  }
  if (order.length < required.length) {
    const stuck = required.filter((t) => !order.includes(t.id)).map((t) => t.id);
    issues.push({ line: byId.get(stuck[0]!)!.line, severity: "error", message: `Tasks ${stuck.join(", ")} depend on each other in a loop.` });
    return { waves: [], moved: [], optional, issues };
  }

  const waveOf = new Map<string, number>();
  const waves: string[][] = [];
  const moved: WavePlan["moved"] = [];
  for (const id of order) {
    const t = byId.get(id)!;
    const earliest = Math.max(0, ...t.deps.filter((d) => waveOf.has(d)).map((d) => waveOf.get(d)! + 1));
    let w = earliest;
    let reason = "";
    for (;;) {
      const members = (waves[w] ?? []).map((m) => byId.get(m)!);
      if (members.length === 0) break;
      if (t.allFiles.length === 0) { reason ||= "declares no files, so it runs alone"; w++; continue; }
      const alone = members.find((m) => m.allFiles.length === 0);
      if (alone) { reason ||= `task ${alone.id} runs alone`; w++; continue; }
      const clash = members.map((m) => ({ m, files: sharedFiles(t.allFiles, m.allFiles) })).find((x) => x.files.length);
      if (clash) { reason ||= `shares ${clash.files.join(", ")} with task ${clash.m.id}`; w++; continue; }
      break;
    }
    (waves[w] ??= []).push(id);
    waveOf.set(id, w);
    if (w > earliest && reason && t.allFiles.length > 0) moved.push({ id, reason });
  }
  return { waves: waves.filter((w) => w.length).map((w) => w.sort(compareIds)), moved, optional, issues };
}

function compareIds(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1);
    if (d) return d;
  }
  return 0;
}
