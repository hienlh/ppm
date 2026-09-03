/**
 * The one pure function every drop target asks "may this land here, and as what?".
 *
 * It runs twice per drop: on `dragover`, where Chromium exposes only `dataTransfer.types`
 * and the in-flight payload has to come from the module ref set at `dragstart`, and again
 * on `drop`, where the real payload is readable. Keeping the rule in one testable place is
 * what stops the highlight and the actual outcome from disagreeing.
 */

import {
  allAlreadyIn, ENTRY_DRAG_MIME, isSelfOrDescendant, resolveDropOperation,
  type DropOperation, type EntryDragPayload,
} from "./entry-drag-payload";

export type DropRejection = "not-an-entry-drag" | "no-target" | "self-or-descendant" | "same-directory";

export type DropDecision =
  | { accept: true; op: DropOperation }
  | { accept: false; reason: DropRejection };

export interface DropDecisionInput {
  /** `dataTransfer.types` — the only thing readable during `dragover`. */
  types: readonly string[];
  /** Payload from the module ref (dragover) or from `dataTransfer` (drop); null when unknown. */
  payload: EntryDragPayload | null;
  /** Directory the drop would write into; null when this element is not a directory. */
  targetDir: string | null;
  modifiers: { ctrlKey: boolean; altKey: boolean };
}

export function decideDrop({ types, payload, targetDir, modifiers }: DropDecisionInput): DropDecision {
  if (!types.includes(ENTRY_DRAG_MIME)) return { accept: false, reason: "not-an-entry-drag" };
  if (targetDir == null || targetDir === "") return { accept: false, reason: "no-target" };

  const op = resolveDropOperation(modifiers);
  // A drag started in another browser tab has the MIME but no readable payload here; accept
  // optimistically so the target still highlights, and let the drop handler re-check.
  if (!payload) return { accept: true, op };

  if (isSelfOrDescendant(payload.paths, targetDir)) return { accept: false, reason: "self-or-descendant" };
  // Copying into the source folder is a legitimate "duplicate"; moving there is a no-op.
  if (op === "move" && allAlreadyIn(payload.paths, targetDir)) {
    return { accept: false, reason: "same-directory" };
  }
  return { accept: true, op };
}
