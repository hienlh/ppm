/**
 * The last gate a dropped payload passes before it touches the filesystem.
 *
 * Everything funnels through the clipboard module's `transfer()`, the same call Paste
 * makes, so drag-and-drop inherits the collision prompt, the trash-first Replace, the
 * cross-device (`EXDEV`) fallback handled server-side and the `fsChanged` refresh of both
 * the source and the destination directory. There are deliberately no optimistic updates:
 * the panes only move once the server has confirmed.
 */

import { toast } from "sonner";
import { transfer, type TransferContext } from "../actions/explorer-actions-clipboard";
import { isSelfOrDescendant, type DropOperation, type EntryDragPayload } from "./entry-drag-payload";

/** How a surface performs the transfer — an explorer window passes its bound action. */
export type DropRunner = (paths: string[], dstDir: string, op: DropOperation) => Promise<void>;

/**
 * Re-checks the self/descendant guard the hover-time decision already applied. The modifier
 * and the pointer can both change between the last `dragover` and the `drop`, and a payload
 * that arrives without ever having been hovered (a target reached by keyboard-driven drop in
 * some browsers) never went through that check at all.
 */
export async function executeEntryDrop(
  payload: EntryDragPayload,
  dstDir: string,
  op: DropOperation,
  run: DropRunner,
): Promise<void> {
  if (payload.paths.length === 0) return;
  if (isSelfOrDescendant(payload.paths, dstDir)) {
    toast.error("Cannot place an item inside itself");
    return;
  }
  await run(payload.paths, dstDir, op);
}

/** A `DropRunner` for surfaces that own a `TransferContext` instead of an explorer action set. */
export function transferRunner(context: TransferContext): DropRunner {
  return async (paths, dstDir, op) => {
    await transfer(paths, dstDir, op, context);
  };
}
