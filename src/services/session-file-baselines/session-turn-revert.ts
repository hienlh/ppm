/**
 * Reverting a turn: every change the turn's calls made, put back on disk where its lines are
 * still as the turn left them — the chat's "Revert turn…".
 *
 * The browser names the turn by its calls (the tool use ids in it), and each file's history
 * (`session-file-history.ts`) says what every call found and left. A file's part of the turn is
 * cut into runs — calls of the turn with no other change between them — and each run's change
 * into hunks with no context, so an edit two lines away does not hold a hunk back. A hunk goes
 * back only where its lines are all still there, unchanged and together. Otherwise it is left
 * as it is and named with what changed it since, which is what the confirmation shows ("Turn 3
 * changed it again"). The newest run goes first, so the turn's own later edits come off before
 * the earlier ones they sit on.
 *
 * A preview writes nothing. Applying works everything out again and refuses outright when a
 * file is no longer at the version the preview was shown at. A revert is journalled like a
 * revert answer, so the same Undo puts it back.
 */
import { readFile, stat } from "node:fs/promises";
import { diffLines } from "diff";
import { decodeText, isBinaryContent } from "../binary-content.ts";
import { assertReadPermitted } from "../fs-ops/fs-ops-read-write.service.ts";
import { realPathOrSelf } from "../fs-ops/fs-real-path.ts";
import { lineMap, splitLines } from "../../shared/review-blocks.ts";
import type { TurnRevertFile, TurnRevertResult } from "../../shared/session-file-changes.ts";
import { BASELINE_MAX_BYTES } from "./session-file-baselines.service.ts";
import { historyPaths, readHistory, type HistoryEntry } from "./session-file-history.ts";
import { journalWrites, versionOf, writeTarget, type Target } from "./session-review-actions.ts";

/** Calls one revert may name: a turn has tens, a long one a few hundred. */
export const MAX_TURN_CALLS = 2000;

/** Diffs here run once per request, not per keystroke: a slower one is still worth waiting for. */
const DIFF_TIMEOUT_MS = 1000;

/** Calls of the turn over one file with no other change between them: the text before the first and after the last. */
interface Run {
  from: string;
  to: string;
  /** The file did not exist before the run, or after it. */
  fromAbsent: boolean;
  toAbsent: boolean;
  /** A state in the run was not text (binary, over the size cap): it cannot be put back by lines. */
  broken: boolean;
  /** The entry the run ends at. */
  end: number;
}

/** One change of a run: lines `of..ot` of its "before" became lines `nf..nt` of its "after". */
interface Hunk { of: number; ot: number; nf: number; nt: number }

function runsOf(entries: HistoryEntry[], calls: Set<string>): Run[] {
  const runs: Run[] = [];
  let run: Run | null = null;
  for (let i = 1; i < entries.length; i++) {
    const a = entries[i - 1]!;
    const b = entries[i]!;
    if (b.phase === "after" && a.phase === "before" && a.call === b.call && calls.has(b.call)) {
      if (!run) {
        run = { from: a.text ?? "", fromAbsent: a.hash === null, to: "", toAbsent: false, broken: a.text === null, end: i };
        runs.push(run);
      }
      run.to = b.text ?? "";
      run.toAbsent = b.hash === null;
      run.broken ||= b.text === null;
      run.end = i;
    } else if (a.hash !== b.hash) {
      // Anything else that changed the file ends the run; a state seen twice does not.
      run = null;
    }
  }
  return runs;
}

function hunksOf(from: string, to: string): Hunk[] | null {
  const parts = diffLines(from, to, { timeout: DIFF_TIMEOUT_MS });
  if (!parts) return null;
  const out: Hunk[] = [];
  let open: Hunk | null = null;
  let o = 0;
  let n = 0;
  for (const part of parts) {
    const k = splitLines(part.value).length;
    if (!part.added && !part.removed) {
      o += k;
      n += k;
      open = null;
      continue;
    }
    if (!open) {
      open = { of: o, ot: o, nf: n, nt: n };
      out.push(open);
    }
    if (part.added) open.nt = n += k;
    else open.ot = o += k;
  }
  return out;
}

/** The start and the end of a file, as neighbours a change can have. */
const START = -1;
const END = -2;

/**
 * The calls that changed each hunk's lines after the run, "" for a change no call made: a line
 * of it taken out, or lines put in between two of its lines — for lines the run took out, between
 * the two lines that were around them.
 */
function changedBy(entries: HistoryEntry[], run: Run, hunks: Hunk[], current: string): string[][] {
  let text = run.to;
  let ids = splitLines(text).map((_, i) => i);
  let nextId = ids.length;
  const owners = new Map<number, number[]>();
  hunks.forEach((h, hi) => {
    const members = h.nt > h.nf
      ? Array.from({ length: h.nt - h.nf }, (_, k) => h.nf + k)
      : [h.nf > 0 ? h.nf - 1 : START, h.nf < ids.length ? h.nf : END];
    for (const id of members) owners.set(id, [...(owners.get(id) ?? []), hi]);
  });
  const by = hunks.map(() => new Set<string>());
  const steps: { text: string | null; label: string }[] = [];
  for (let i = run.end + 1; i < entries.length; i++) {
    const a = entries[i - 1]!;
    const b = entries[i]!;
    steps.push({ text: b.text, label: b.phase === "after" && a.phase === "before" && a.call === b.call ? b.call : "" });
  }
  steps.push({ text: current, label: "" });
  for (const step of steps) {
    if (step.text === null || step.text === text) continue;
    const parts = diffLines(text, step.text, { timeout: DIFF_TIMEOUT_MS });
    if (!parts) {
      for (const set of by) set.add(step.label);
      break;
    }
    const next: number[] = [];
    let i = 0;
    for (const part of parts) {
      const k = splitLines(part.value).length;
      if (part.added) {
        const left = owners.get(i > 0 ? ids[i - 1]! : START) ?? [];
        const right = new Set(owners.get(i < ids.length ? ids[i]! : END) ?? []);
        for (const hi of left) if (right.has(hi)) by[hi]!.add(step.label);
        for (let j = 0; j < k; j++) next.push(nextId++);
      } else if (part.removed) {
        for (let j = 0; j < k; j++) for (const hi of owners.get(ids[i++]!) ?? []) by[hi]!.add(step.label);
      } else {
        for (let j = 0; j < k; j++) next.push(ids[i++]!);
      }
    }
    ids = next;
    text = step.text;
  }
  return by.map((set) => [...set]);
}

/**
 * Where line `index` of a run's "after" sits in the file now (1-based): its own place, or just
 * past the nearest line before it that is still there.
 */
function lineNow(where: Int32Array | null, index: number): number {
  if (!where) return 1;
  for (let i = Math.min(index, where.length - 1); i >= 0; i--) {
    if (where[i]! >= 0) return where[i]! + (i < index ? 2 : 1);
  }
  return 1;
}

/**
 * Whether the run's "before" lines `of..ot` stand together in the file now, right between the
 * lines that were around them — the hunk is already as the run found it. `was` maps the run's
 * "before" into the file now.
 */
function isBack(was: Int32Array, h: Hunk, lines: number): boolean {
  if (h.of > 0 && was[h.of - 1]! < 0) return false;
  let next = h.of > 0 ? was[h.of - 1]! + 1 : 0;
  for (let i = h.of; i < h.ot; i++, next++) if (was[i] !== next) return false;
  return h.ot < was.length ? was[h.ot] === next : next === lines;
}

interface Plan {
  file: TurnRevertFile;
  /** What to write, when anything. */
  target?: Target;
}

function emptyFile(path: string, version: string, error?: string): TurnRevertFile {
  return { path, version, action: "none", changes: 0, added: 0, removed: 0, skipped: [], ...(error ? { error } : {}) };
}

/** The file now: its text ("" when it does not exist), or why it cannot be reverted by lines. */
async function readNow(path: string): Promise<{ exists: boolean; text: string } | string> {
  try {
    assertReadPermitted(path, await realPathOrSelf(path));
  } catch (e) {
    return (e as Error).message;
  }
  try {
    const st = await stat(path);
    if (!st.isFile()) return "This is not a file.";
    if (st.size > BASELINE_MAX_BYTES) return "This file is too large to revert by lines.";
    const bytes = new Uint8Array(await readFile(path));
    if (isBinaryContent(bytes)) return "A binary file cannot be reverted by lines.";
    const text = decodeText(bytes);
    return text.includes("\uFFFD") ? "This file is not plain UTF-8 text, so it can only be reverted by hand." : { exists: true, text };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { exists: false, text: "" } : (e as Error).message;
  }
}

/** What reverting `calls` does to one file, worked out against the disk as it is now. */
async function planFile(sessionId: string, path: string, calls: Set<string>): Promise<Plan | null> {
  const { entries } = readHistory(sessionId, path);
  const runs = runsOf(entries, calls);
  if (runs.length === 0) return null;
  const version = await versionOf(path);
  const now = await readNow(path);
  if (typeof now === "string") return { file: emptyFile(path, version, now) };
  if (runs.some((r) => r.broken)) {
    return { file: emptyFile(path, version, "This turn left the file binary or too large to revert by lines.") };
  }
  if (runs.some((r) => r.from.includes("\uFFFD") || r.to.includes("\uFFFD"))) {
    return { file: emptyFile(path, version, "This file is not plain UTF-8 text, so it can only be reverted by hand.") };
  }

  let working = now.text;
  let exists = now.exists;
  let changes = 0;
  let added = 0;
  let removed = 0;
  const skipped: TurnRevertFile["skipped"] = [];
  for (const run of [...runs].reverse()) {
    const hunks = hunksOf(run.from, run.to);
    const at = hunks && lineMap(run.to, working, DIFF_TIMEOUT_MS);
    const was = at && lineMap(run.from, working, DIFF_TIMEOUT_MS);
    if (!hunks || !at || !was) return { file: emptyFile(path, version, "This change is too large to work out line by line.") };
    const lines = splitLines(working);
    const count = lines.length;
    const before = splitLines(run.from);
    const left: number[] = [];
    // Last hunk first, so the places worked out for the others stay where they are.
    for (let hi = hunks.length - 1; hi >= 0; hi--) {
      const h = hunks[hi]!;
      // Already as the run found it — reverted before, or put back by hand: nothing to do.
      if (isBack(was, h, count)) continue;
      let place = -1;
      if (h.nt > h.nf) {
        const start = at[h.nf]!;
        let together = start >= 0;
        for (let i = h.nf; together && i < h.nt; i++) together = at[i] === start + i - h.nf;
        if (together) place = start;
        if (place >= 0) lines.splice(place, h.nt - h.nf, ...before.slice(h.of, h.ot));
      } else {
        // Lines the run took out go back between the two lines that were around them (the start
        // or the end of the file counting as one), or next to the one still there. Anything put
        // in between those two since makes the place a guess, and the change is left.
        const prev = h.nf > 0 ? at[h.nf - 1]! : -1;
        const next = h.nf < at.length ? at[h.nf]! : count;
        const prevThere = h.nf === 0 || prev >= 0;
        const nextThere = h.nf === at.length || next >= 0;
        if (prevThere && nextThere) place = next === prev + 1 ? next : -1;
        else if (prevThere) place = prev + 1;
        else if (nextThere) place = next;
        if (place >= 0) lines.splice(place, 0, ...before.slice(h.of, h.ot));
      }
      if (place < 0) {
        left.push(hi);
        continue;
      }
      changes++;
      added += h.nt - h.nf;
      removed += h.ot - h.of;
    }
    if (left.length > 0) {
      const by = changedBy(entries, run, hunks, now.text);
      const where = lineMap(run.to, now.text, DIFF_TIMEOUT_MS);
      for (const hi of left) {
        const others = by[hi]!.filter((call) => !calls.has(call));
        // Held back only by the turn's own later change, which is held back itself and named there.
        if (by[hi]!.length > 0 && others.length === 0) continue;
        skipped.push({ line: lineNow(where, hunks[hi]!.nf), by: others });
      }
    }
    working = lines.join("");
    // A file the run deleted, still gone, comes back; one it created goes again once nothing is left in it.
    if (run.toAbsent && !exists) exists = !run.fromAbsent;
    else if (run.fromAbsent && exists && working === "" && left.length === 0) exists = false;
  }

  let action: TurnRevertFile["action"] = "none";
  if (exists !== now.exists) action = exists ? "restore" : "delete";
  else if (exists && working !== now.text) action = "edit";
  const target: Target | undefined = action === "none" ? undefined : exists ? { exists: true, bytes: working } : { exists: false };
  return {
    file: { path, version, action, changes, added, removed, skipped: skipped.sort((a, b) => a.line - b.line) },
    ...(target ? { target } : {}),
  };
}

async function planAll(sessionId: string, calls: Set<string>): Promise<Plan[]> {
  const plans: Plan[] = [];
  for (const path of historyPaths(sessionId).sort()) {
    const plan = await planFile(sessionId, path, calls);
    if (plan) plans.push(plan);
  }
  return plans;
}

/**
 * Work out — or, with `apply`, make — the revert of the turn whose calls are `calls`. `apply`
 * carries the version of each file as the preview showed it: if any file has moved since, or
 * the turn reaches a file the preview did not show, nothing is written and the result is the
 * preview worked out again, `stale`.
 */
export async function revertTurn(p: {
  sessionId: string;
  calls: string[];
  apply?: { path: string; version: string }[];
}): Promise<TurnRevertResult> {
  const plans = await planAll(p.sessionId, new Set(p.calls.slice(0, MAX_TURN_CALLS)));
  const files = plans.map((plan) => plan.file);
  if (!p.apply) return { files };

  const shown = new Map(p.apply.map((f) => [f.path, f.version]));
  if (plans.some((plan) => shown.get(plan.file.path) !== plan.file.version)) return { files, stale: true };

  const writes: Parameters<typeof journalWrites>[1] = [];
  for (const plan of plans) {
    const target = plan.target;
    if (!target) continue;
    const path = plan.file.path;
    try {
      const before = await readFile(path).then((b) => new Uint8Array(b), () => null);
      const afterVersion = await writeTarget(path, target);
      writes.push({ path, before, after: target.exists ? (target.bytes as string) : null, afterVersion });
    } catch (e) {
      // What was written so far stays written, and journalled, so Undo still covers it.
      plan.file.error = (e as Error).message;
      plan.file.action = "none";
    }
  }
  const undoId = journalWrites(p.sessionId, writes);
  return { files, ...(undoId ? { undoId } : {}) };
}
