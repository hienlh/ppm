/**
 * Cut / copy / paste against the real filesystem, plus the collision prompt.
 *
 * The clipboard itself lives in `file-store` and holds absolute paths, so a cut in the
 * project tree can be pasted into an explorer window and the other way round. Everything
 * here goes through `/api/fs/*`; the tree keeps its project-scoped routes for the case
 * where both ends are inside the same project.
 */

import { toast } from "sonner";
import { fsApi, FsError } from "@/lib/fs-api";
import { useFileStore, type ClipboardState } from "@/stores/file-store";
import { dirnameOf, errorDescription, joinPath } from "../format-file-meta";
import { fsChanged } from "../explorer-store";
import { freeName, runOne } from "./explorer-actions-transfer-helpers";

export type CollisionChoice = "replace" | "keep-both" | "skip";

export interface CollisionRequest {
  name: string;
  destination: string;
}

/** Asks the user what to do about an existing file. Returning "skip" is always safe. */
export type CollisionResolver = (request: CollisionRequest) => Promise<CollisionChoice>;

export interface TransferContext {
  sep: string;
  resolve: CollisionResolver;
  /**
   * Asked only when "Replace" cannot trash the existing entry (`NO_TRASH`) — the dialog copy
   * promises a recoverable trash-first replace, so silently falling back to a permanent
   * delete would contradict what the user just agreed to. Returning false skips the item.
   */
  confirmPermanentOverwrite(name: string): Promise<boolean>;
  /**
   * Brackets one batch of parallel `resolve()` calls sharing this context's collision prompt
   * (one paste, one drag, one upload), so "Apply to all" scopes to just that batch. Optional —
   * a caller with no concurrent collisions (or a test building a bare context) can omit them.
   */
  startBatch?(): void;
  endBatch?(): void;
}

export interface TransferResult {
  succeeded: number;
  skipped: number;
  failed: number;
}

/**
 * Copy or move `sources` into `dstDir`.
 *
 * Exported on its own (not just through the clipboard) because drag-and-drop performs the
 * exact same operation with a different trigger.
 */
export async function transfer(
  sources: string[],
  dstDir: string,
  op: "copy" | "move",
  ctx: TransferContext,
): Promise<TransferResult> {
  const result: TransferResult = { succeeded: 0, skipped: 0, failed: 0 };
  const touched = new Set<string>([dstDir]);

  // `transfer()` itself resolves collisions one source at a time, but two *calls* to it can
  // overlap (a paste fired while a drag-drop transfer is still resolving) sharing the same
  // dialog — bracket this call so "Apply to all" only ever covers its own sources.
  ctx.startBatch?.();
  try {
    await transferSources(sources, dstDir, op, ctx, result, touched);
  } finally {
    ctx.endBatch?.();
  }

  fsChanged(...touched);
  return result;
}

async function transferSources(
  sources: string[],
  dstDir: string,
  op: "copy" | "move",
  ctx: TransferContext,
  result: TransferResult,
  touched: Set<string>,
): Promise<void> {
  for (const source of sources) {
    const name = source.split(/[/\\]/).filter(Boolean).pop() ?? source;
    const sourceDir = dirnameOf(source, ctx.sep);
    touched.add(sourceDir);
    // Moving an entry into the folder it already lives in is a no-op, not an error.
    if (op === "move" && sourceDir === dstDir) {
      result.skipped++;
      continue;
    }

    let destination = joinPath(dstDir, name, ctx.sep);
    // A copy into the same folder always collides with itself (destination === source),
    // which the server refuses as self-nesting (EINVAL), not EEXIST — so the collision
    // prompt would never open. Every OS instead makes this "name (2)" directly.
    if (op === "copy" && sourceDir === dstDir) {
      const alternative = await freeName(dstDir, name, ctx.sep);
      if (!alternative) {
        result.failed++;
        toast.error(`Copy failed: ${name}`, { description: "No free name available" });
        continue;
      }
      destination = joinPath(dstDir, alternative, ctx.sep);
      try {
        await runOne(source, destination, op);
        result.succeeded++;
      } catch (e) {
        result.failed++;
        toast.error(`Copy failed: ${name}`, { description: errorDescription(e) });
      }
      continue;
    }

    try {
      await runOne(source, destination, op);
      result.succeeded++;
      continue;
    } catch (e) {
      if (!(e instanceof FsError) || e.code !== "EEXIST") {
        result.failed++;
        toast.error(`${op === "copy" ? "Copy" : "Move"} failed: ${name}`, { description: errorDescription(e) });
        continue;
      }
    }

    const choice = await ctx.resolve({ name, destination });
    if (choice === "skip") {
      result.skipped++;
      continue;
    }
    if (choice === "keep-both") {
      try {
        const alternative = await freeName(dstDir, name, ctx.sep);
        if (!alternative) throw new Error("No free name available");
        destination = joinPath(dstDir, alternative, ctx.sep);
        await runOne(source, destination, op);
        result.succeeded++;
      } catch (e) {
        result.failed++;
        toast.error(`${op === "copy" ? "Copy" : "Move"} failed: ${name}`, { description: errorDescription(e) });
      }
      continue;
    }

    // Replace: trash the existing entry first so the overwrite stays recoverable, matching
    // the collision dialog's own copy.
    try {
      await fsApi.remove(destination, false);
    } catch (e) {
      if (!(e instanceof FsError) || e.code !== "NO_TRASH") {
        result.failed++;
        toast.error(`Could not remove existing ${name}`, { description: errorDescription(e) });
        continue;
      }
      // No trash backend on this host — the dialog's "moves to Trash" promise cannot be
      // kept, so ask explicitly before doing something permanent instead of silently
      // downgrading to it.
      const proceed = await ctx.confirmPermanentOverwrite(name);
      if (!proceed) {
        result.skipped++;
        continue;
      }
      try {
        await fsApi.remove(destination, true);
      } catch (removeErr) {
        result.failed++;
        toast.error(`Could not remove existing ${name}`, { description: errorDescription(removeErr) });
        continue;
      }
    }
    try {
      await runOne(source, destination, op);
      result.succeeded++;
    } catch (e) {
      result.failed++;
      // The existing entry is already gone (trashed or deleted above) but the replacement
      // was never written — say so explicitly rather than a generic "Copy/Move failed".
      toast.error(`${name} was removed but the replacement could not be written`, { description: errorDescription(e) });
    }
  }
}

/** Put absolute paths on the shared clipboard. `origin` lets the tree keep its own routes. */
export function setClipboardPaths(
  paths: string[],
  operation: "cut" | "copy",
  origin?: ClipboardState["origin"],
): void {
  if (paths.length === 0) return;
  useFileStore.getState().setClipboard({ paths: [...paths], operation, origin });
}

/** Paste the shared clipboard into `dstDir`. A cut clipboard is consumed on success. */
export async function pasteInto(dstDir: string, ctx: TransferContext): Promise<void> {
  const clipboard = useFileStore.getState().clipboard;
  if (!clipboard || clipboard.paths.length === 0) return;

  const result = await transfer(clipboard.paths, dstDir, clipboard.operation === "cut" ? "move" : "copy", ctx);
  if (clipboard.operation === "cut" && result.failed === 0) {
    useFileStore.getState().setClipboard(null);
  }
  if (result.succeeded > 0) {
    const verb = clipboard.operation === "cut" ? "Moved" : "Copied";
    toast.success(`${verb} ${result.succeeded} item${result.succeeded === 1 ? "" : "s"}`);
  }
}
