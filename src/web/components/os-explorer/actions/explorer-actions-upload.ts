/**
 * Turns a dropped/picked file batch into `PUT /api/fs/upload` calls, streamed through
 * `uploadFileXhr` with bounded concurrency. Mirrors `transfer()` in
 * `explorer-actions-clipboard.ts`: the same collision prompt (`ctx.resolve`), the same
 * trash-first "Replace" (delete via `/api/fs/delete`, then upload) and a `fsChanged` refresh
 * once the batch settles — drag-to-upload and the picker both funnel through this one
 * function.
 *
 * Per-file state lives in `upload-store.ts`, which backs the persistent progress panel that
 * replaced the old "Uploading N files… NN%" toast — that toast had no room for a cancel
 * button or per-file outcomes, and its single collision-dialog slot is the bug this module
 * used to have (see `use-collision-prompt.ts`).
 */

import { fsApi, FsError } from "@/lib/fs-api";
import { uploadFileXhr } from "@/lib/fs-upload-xhr";
import { dirnameOf, joinPath } from "../format-file-meta";
import { fsChanged } from "../explorer-store";
import type { DroppedEntry } from "../upload/collect-dropped-entries";
import { describeUploadError } from "../upload/upload-error-message";
import { useUploadStore } from "../upload/upload-store";
import { runUploadQueue, type UploadJob } from "../upload/upload-queue";
import type { TransferContext } from "./explorer-actions-clipboard";
import { freeName } from "./explorer-actions-transfer-helpers";

/** Uploads sitting behind a collision prompt or a slow connection should not all queue up
 *  behind one giant file — three in flight matches the plan's chosen concurrency. */
const CONCURRENCY = 3;

function nameOf(relativePath: string): string {
  return relativePath.split("/").pop() ?? relativePath;
}

/** Turns a "/"-joined relative path (as `collectDroppedEntries` produces) into a host path
 *  under `dstDir`, using the destination's own separator. */
function destinationFor(dstDir: string, relativePath: string, sep: string): string {
  return joinPath(dstDir, relativePath.split("/").join(sep), sep);
}

async function uploadResolvingCollisions(
  entry: DroppedEntry,
  dstDir: string,
  sep: string,
  ctx: TransferContext,
  signal: AbortSignal,
  onProgress: (bytesLoaded: number) => void,
): Promise<"done" | "skipped"> {
  const destination = destinationFor(dstDir, entry.relativePath, sep);
  try {
    await uploadFileXhr(destination, entry.file, false, (p) => onProgress(p.loaded), signal);
    return "done";
  } catch (e) {
    if (!(e instanceof FsError) || e.code !== "EEXIST") throw e;
  }

  const name = nameOf(entry.relativePath);
  const choice = await ctx.resolve({ name, destination });
  if (choice === "skip") return "skipped";
  if (choice === "keep-both") {
    const containingDir = dirnameOf(destination, sep);
    const alternative = await freeName(containingDir, name, sep);
    if (!alternative) throw new Error("No free name available");
    await uploadFileXhr(joinPath(containingDir, alternative, sep), entry.file, false, (p) => onProgress(p.loaded), signal);
    return "done";
  }

  // Replace: trash the existing entry first, same as copy/move's `transfer()` — the dialog's
  // "moves the existing item to the Trash first" copy has to hold for every caller of it.
  try {
    await fsApi.remove(destination, false);
  } catch (e) {
    if (!(e instanceof FsError) || e.code !== "NO_TRASH") throw e;
    // No trash backend on this host — ask before doing something permanent instead of
    // silently downgrading to it (mirrors `transfer()`'s own NO_TRASH handling).
    const proceed = await ctx.confirmPermanentOverwrite(name);
    if (!proceed) return "skipped";
    await fsApi.remove(destination, true);
  }
  await uploadFileXhr(destination, entry.file, true, (p) => onProgress(p.loaded), signal);
  return "done";
}

export async function uploadEntries(
  entries: DroppedEntry[],
  dstDir: string,
  sep: string,
  ctx: TransferContext,
): Promise<void> {
  if (entries.length === 0) return;

  const batchId = crypto.randomUUID();
  const store = useUploadStore.getState();
  store.addBatch(
    batchId,
    dstDir,
    entries.map((entry, index) => ({
      id: String(index),
      name: nameOf(entry.relativePath),
      relativePath: entry.relativePath,
      size: entry.file.size,
    })),
  );

  const controllers = entries.map((_, index) => {
    const controller = new AbortController();
    store.registerCanceller(batchId, String(index), () => controller.abort());
    return controller;
  });

  // Serializes this batch's collision prompts through the shared queue (see
  // `use-collision-prompt.ts`) and scopes "Apply to all" to just these entries.
  ctx.startBatch?.();
  try {
    const jobs: UploadJob<void>[] = entries.map((entry, index) => {
      const id = String(index);
      const controller = controllers[index]!;
      return {
        id,
        size: entry.file.size,
        run: async (onProgress) => {
          if (controller.signal.aborted) {
            store.setItemState(batchId, id, "cancelled");
            throw new DOMException("Upload aborted", "AbortError");
          }
          store.setItemState(batchId, id, "uploading");
          try {
            const outcome = await uploadResolvingCollisions(
              entry, dstDir, sep, ctx, controller.signal,
              (loaded) => {
                onProgress(loaded);
                store.setItemProgress(batchId, id, loaded);
              },
            );
            store.setItemState(batchId, id, outcome === "skipped" ? "skipped" : "done");
          } catch (e) {
            const cancelled = e instanceof DOMException && e.name === "AbortError";
            store.setItemState(batchId, id, cancelled ? "cancelled" : "failed", cancelled ? undefined : describeUploadError(e));
            throw e;
          }
        },
      };
    });

    // The aggregate progress callback is unused here — the panel reads per-item state
    // straight from the store, updated above as each job settles.
    await runUploadQueue(jobs, CONCURRENCY, () => {});
  } finally {
    ctx.endBatch?.();
    fsChanged(dstDir);
  }
}
