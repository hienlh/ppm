/**
 * Where one turn's edits stand in the session's review, for the chat's change tray: an edit is
 * its call's blocks in the session's list (`SessionBlockSummary.calls`), open until each of them
 * is kept, and reverted once none is left.
 *
 * Pure, so the tray's pill and its rows read the same answer.
 */
import type { FileEditFragment, TurnFileChange } from "./aggregate-turn-file-changes";
import type { SessionFileChange } from "../../shared/session-file-changes";

export type EditReviewState = "open" | "kept" | "reverted";

export interface EditReview {
  /** Null where the list cannot say: a session from before blocks named their calls, a binary file. */
  state: EditReviewState | null;
  /** The file as the list has it, at the version an answer has to name. */
  file?: SessionFileChange;
  /** The blocks the edit's call wrote, or that still hold some of it. */
  keys: string[];
  /** Names a revert made from the tray, for Change to undo it. */
  undoId?: string;
}

export interface TurnReviewSummary {
  open: number;
  kept: number;
  reverted: number;
  /** Edits the list says anything about; none means the tray shows no review at all. */
  known: number;
}

/** Names one edit in a turn: a call can edit several files (a codex patch), a MultiEdit one file several times. */
export const editKey = (filePath: string, edit: Pick<FileEditFragment, "toolUseId" | "editIndex">) =>
  `${filePath}\0${edit.toolUseId ?? ""}\0${edit.editIndex}`;

const norm = (path: string) => path.replace(/\\/g, "/");

export function editReviews(
  changes: readonly TurnFileChange[],
  files: readonly SessionFileChange[],
  /** Reverts made from the tray: edit key to the revert's undo id. */
  reverted: ReadonlyMap<string, string>,
): Map<string, EditReview> {
  const byPath = new Map(files.map((f) => [norm(f.path), f]));
  const out = new Map<string, EditReview>();
  for (const change of changes) {
    const file = byPath.get(norm(change.filePath));
    // The list can only say an edit is gone once the file's blocks name the calls that wrote them.
    const named = !!file?.blocks?.some((b) => b.calls?.length);
    for (const edit of change.edits) {
      const key = editKey(change.filePath, edit);
      const undoId = reverted.get(key);
      const blocks = edit.toolUseId && file?.blocks ? file.blocks.filter((b) => b.calls?.includes(edit.toolUseId!)) : [];
      let state: EditReviewState | null = null;
      if (blocks.length > 0) state = blocks.every((b) => b.kept) ? "kept" : "open";
      // Compared with what the user marked reviewed: what came before the mark was reviewed.
      else if (file?.sinceReview && edit.toolUseId) state = "kept";
      else if (undoId || (named && edit.toolUseId)) state = "reverted";
      out.set(key, { state, ...(file ? { file } : {}), keys: blocks.map((b) => b.key), ...(undoId ? { undoId } : {}) });
    }
  }
  return out;
}

export function turnReviewSummary(reviews: ReadonlyMap<string, EditReview>): TurnReviewSummary {
  const s: TurnReviewSummary = { open: 0, kept: 0, reverted: 0, known: 0 };
  for (const r of reviews.values()) {
    if (!r.state) continue;
    s.known++;
    s[r.state]++;
  }
  return s;
}

/** What the pill says after the file count: what is left to answer, or how it went. */
export function turnReviewLabel(s: TurnReviewSummary): { tone: "todo" | "kept" | "reverted"; text: string } | null {
  if (s.known === 0) return null;
  if (s.open > 0) return { tone: "todo", text: `${s.open} edit${s.open === 1 ? "" : "s"} to review` };
  if (s.reverted > 0) return { tone: "reverted", text: `${s.reverted} reverted` };
  return { tone: "kept", text: "Kept" };
}

/**
 * The answer that covers `reviews`, one entry per file at the version the list drew it: the
 * blocks still open for a keep, every block named for a reopen or a revert.
 */
export function answerFiles(
  reviews: readonly EditReview[],
  which: "open" | "all",
): { path: string; version: string; keys: string[] }[] {
  const byPath = new Map<string, { path: string; version: string; keys: Set<string> }>();
  for (const r of reviews) {
    if (!r.file) continue;
    const open = new Set(r.file.blocks?.filter((b) => !b.kept).map((b) => b.key));
    const keys = which === "open" ? r.keys.filter((k) => open.has(k)) : r.keys;
    if (keys.length === 0) continue;
    const entry = byPath.get(r.file.path) ?? { path: r.file.path, version: r.file.version, keys: new Set<string>() };
    for (const k of keys) entry.keys.add(k);
    byPath.set(r.file.path, entry);
  }
  return [...byPath.values()].map((e) => ({ path: e.path, version: e.version, keys: [...e.keys] }));
}
