/**
 * Turns a dropped/picked file batch into `PUT /api/fs/upload` calls, streamed through
 * `uploadFileXhr` with bounded concurrency. Mirrors `transfer()` in
 * `explorer-actions-clipboard.ts`: the same collision prompt (`ctx.resolve`), the same
 * trash-first "Replace" via the 409 `EEXIST` contract, and a `fsChanged` refresh once the
 * batch settles — drag-to-upload and the picker both funnel through this one function.
 */

import { toast } from "sonner";
import { FsError } from "@/lib/fs-api";
import { uploadFileXhr } from "@/lib/fs-upload-xhr";
import { dirnameOf, joinPath } from "../format-file-meta";
import { fsChanged } from "../explorer-store";
import type { DroppedEntry } from "../upload/collect-dropped-entries";
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
  onProgress: (bytesLoaded: number) => void,
): Promise<void> {
  const destination = destinationFor(dstDir, entry.relativePath, sep);
  try {
    await uploadFileXhr(destination, entry.file, false, (p) => onProgress(p.loaded));
    return;
  } catch (e) {
    if (!(e instanceof FsError) || e.code !== "EEXIST") throw e;
  }

  const name = nameOf(entry.relativePath);
  const choice = await ctx.resolve({ name, destination });
  if (choice === "skip") return;
  if (choice === "keep-both") {
    const containingDir = dirnameOf(destination, sep);
    const alternative = await freeName(containingDir, name, sep);
    if (!alternative) throw new Error("No free name available");
    await uploadFileXhr(joinPath(containingDir, alternative, sep), entry.file, false, (p) => onProgress(p.loaded));
    return;
  }
  // Replace: the server upload route itself makes the overwrite atomic (tmp file + rename),
  // so unlike the copy/move `transfer()` there is no separate trash-then-write step here.
  await uploadFileXhr(destination, entry.file, true, (p) => onProgress(p.loaded));
}

function uploadLabel(entries: DroppedEntry[], fraction: number): string {
  const label = entries.length === 1 ? entries[0]!.file.name : `${entries.length} files`;
  return `Uploading ${label}… ${Math.round(fraction * 100)}%`;
}

export async function uploadEntries(
  entries: DroppedEntry[],
  dstDir: string,
  sep: string,
  ctx: TransferContext,
): Promise<void> {
  if (entries.length === 0) return;

  const toastId = toast.loading(uploadLabel(entries, 0));
  const jobs: UploadJob<void>[] = entries.map((entry, index) => ({
    id: String(index),
    size: entry.file.size,
    run: (onProgress) => uploadResolvingCollisions(entry, dstDir, sep, ctx, onProgress),
  }));

  const results = await runUploadQueue(jobs, CONCURRENCY, (progress) => {
    const fraction = progress.bytesTotal > 0 ? progress.bytesLoaded / progress.bytesTotal : 0;
    toast.loading(uploadLabel(entries, fraction), { id: toastId });
  });

  fsChanged(dstDir);
  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;
  if (failed === 0) {
    toast.success(`Uploaded ${succeeded} item${succeeded === 1 ? "" : "s"}`, { id: toastId });
  } else {
    toast.error(`Uploaded ${succeeded}, ${failed} failed`, { id: toastId });
  }
}
