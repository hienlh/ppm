import { randomBytes } from "node:crypto";
import { DesignError } from "./design-error.ts";
import { designLockKey } from "./design-lock.ts";
import { withRecoveredDesign } from "./design-restore-journal.ts";
import { snapshotDesign } from "./design-snapshots.service.ts";
import { resolveScopedPath } from "./preview/design-preview-scope.ts";
import { readDesignSource, writeDesignSource } from "./source/design-source-file.ts";

/**
 * Undo for canvas writes (a move/resize, a tweak Apply), exact to the bytes it changed.
 *
 * Restoring the `before-edit` snapshot instead would also throw away every AI turn that ran
 * since, so each write records the spans it replaced — where, the text before, the text
 * after — and the file gens it left behind. Undo puts back only those spans, and only while
 * they still read exactly as the write left them: a file that is byte-for-byte the one the
 * write produced qualifies, and so does one an AI turn changed elsewhere without moving the
 * span. Anything else answers `cannot-undo`, and the snapshot in History stays the way back.
 *
 * The journal is in memory, per design, holding the last 50 writes, and is lost on restart.
 * The client only ever sends the id, so undo never writes text that came from a request.
 */

export interface EditSpan {
  /** Path relative to the design folder, `/`-separated. */
  file: string;
  start: number;
  oldText: string;
  newText: string;
}

interface UndoEntry {
  id: string;
  spans: EditSpan[];
  genAfter: Record<string, string>;
}

export const UNDO_ID_RE = /^[0-9a-f]{16}$/;
export const MAX_UNDO_ENTRIES = 50;
/** A write whose spans hold more text than this is not journaled (the snapshot remains). */
const MAX_ENTRY_CHARS = 2 * 1024 * 1024;
const CONTEXT_CHARS = 32;

const journals = new Map<string, UndoEntry[]>();

/**
 * One span turning `before` into `after` (null when equal): the changed region plus up to
 * 32 unchanged characters on each side, so the undo check compares more than a changed
 * digit or two against the file.
 */
export function changedSpan(file: string, before: string, after: string): EditSpan | null {
  if (before === after) return null;
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let tail = 0;
  while (tail < max - start && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) tail++;
  start = Math.max(0, start - CONTEXT_CHARS);
  tail = Math.max(0, tail - CONTEXT_CHARS);
  return { file, start, oldText: before.slice(start, before.length - tail), newText: after.slice(start, after.length - tail) };
}

/** Journal one write; the id undoes it. Null when there is nothing to undo or it is too large to keep. */
export function recordEdit(projectPath: string, slug: string, spans: readonly EditSpan[], genAfter: Record<string, string>): string | null {
  const size = spans.reduce((n, s) => n + s.oldText.length + s.newText.length, 0);
  if (spans.length === 0 || size > MAX_ENTRY_CHARS) return null;
  const key = designLockKey(projectPath, slug);
  const list = journals.get(key) ?? [];
  const id = randomBytes(8).toString("hex");
  list.push({ id, spans: spans.map((s) => ({ ...s })), genAfter: { ...genAfter } });
  while (list.length > MAX_UNDO_ENTRIES) list.shift();
  journals.set(key, list);
  return id;
}

const notFound = (): DesignError => new DesignError(404, "ENOENT", "Nothing to undo: that edit is unknown or too old");
const cannotUndo = (file: string): DesignError =>
  new DesignError(409, "cannot-undo", `Cannot undo: ${file} changed since. Version history still has the state before the edit.`);

/** Reverts one journaled write. 404 for an unknown id, 409 `cannot-undo` when its spans changed. */
export async function undoEdit(projectPath: string, slug: string, undoId: unknown): Promise<{ gen: string; gens: Record<string, string> }> {
  if (typeof undoId !== "string" || !UNDO_ID_RE.test(undoId)) throw notFound();
  const key = designLockKey(projectPath, slug);
  return withRecoveredDesign(projectPath, slug, async () => {
    const list = journals.get(key) ?? [];
    const entry = list.find((e) => e.id === undoId);
    if (!entry) throw notFound();
    const files = [...new Set(entry.spans.map((s) => s.file))];
    const loaded: Array<{ file: string; abs: string; text: string; bom: boolean }> = [];
    for (const file of files) {
      let abs: string;
      let source: Awaited<ReturnType<typeof readDesignSource>>;
      try {
        abs = (await resolveScopedPath({ projectPath, slug }, `${slug}/${file}`)).abs;
        source = await readDesignSource(abs);
      } catch (e) {
        // Deleted or renamed since the edit: that is a change like any other.
        if ((e as { code?: string }).code !== "ENOENT") throw e;
        list.splice(list.indexOf(entry), 1);
        throw cannotUndo(file);
      }
      // Last span first, so an earlier one's start is still valid when it is reverted.
      const spans = entry.spans.filter((s) => s.file === file).sort((a, b) => b.start - a.start);
      // An empty span cannot be checked against the text, so only an unchanged file will do.
      const intact = source.gen === entry.genAfter[file]
        || spans.every((s) => s.newText !== "" && source.text.slice(s.start, s.start + s.newText.length) === s.newText);
      if (!intact) {
        list.splice(list.indexOf(entry), 1);
        throw cannotUndo(file);
      }
      let text = source.text;
      for (const s of spans) text = text.slice(0, s.start) + s.oldText + text.slice(s.start + s.newText.length);
      loaded.push({ file, abs, text, bom: source.bom });
    }
    await snapshotDesign(projectPath, slug, "before-edit");
    const gens: Record<string, string> = {};
    for (const f of loaded) gens[f.file] = await writeDesignSource(f.abs, f.text, { bom: f.bom });
    list.splice(list.indexOf(entry), 1);
    return { gen: gens[entry.spans[0]!.file]!, gens };
  });
}

/** Forget every journal; for tests. */
export function resetDesignUndoJournals(): void {
  journals.clear();
}
