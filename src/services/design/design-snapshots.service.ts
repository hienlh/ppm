import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  DESIGN_SNAPSHOT_REASONS, type DesignSnapshotInfo, type DesignSnapshotReason,
} from "../../shared/design-types.ts";
import { resolveDesignDir } from "./design-paths.ts";
import { readDesignFileSafe, safeWalkDesignTree, type SafeWalkEntry } from "./design-safe-walk.ts";
import {
  ensureHistoryDir, newSnapshotId, pruneSnapshotHistory, readSnapshotHistory,
  SNAPSHOT_FILES, SNAPSHOT_META,
} from "./design-snapshot-history.ts";
import { withRecoveredDesign } from "./design-restore-journal.ts";
import { emitDesignEvent } from "./design-events.ts";
import { DesignError, isDesignError } from "./design-error.ts";

/**
 * Snapshots are plain file copies of a design folder (minus `.design/`) kept in
 * `.design/history/`, not git commits: the user does not want a commit per AI turn.
 *
 * A snapshot identical to the newest one is not taken (tree-hash dedupe), a design over
 * {@link SNAPSHOT_MAX_BYTES} is skipped with a warning rather than copied every turn, and
 * retention runs per reason (see `pruneSnapshotHistory`).
 */

export const SNAPSHOT_MAX_BYTES = 50 * 1024 * 1024;
export const SNAPSHOT_MAX_FILES = 5000;

export type SnapshotResult =
  | { id: string }
  | { skipped: "unchanged"; sameAs: string }
  | { skipped: "too-large" | "missing" };

export interface SnapshotMeta {
  sessionId?: string;
  restoreOf?: string;
}

interface ReadTree {
  files: { rel: string; data: Buffer }[];
  bytes: number;
  treeHash: string;
}

/** Walk and read a tree, or null when it is over the size or file-count budget. */
export async function readDesignTree(root: string, opts: { skipDotDesign?: boolean } = {}): Promise<ReadTree | null> {
  const entries: SafeWalkEntry[] = [];
  let listed = 0;
  for await (const entry of safeWalkDesignTree(root, opts)) {
    listed += entry.size;
    entries.push(entry);
    if (listed > SNAPSHOT_MAX_BYTES || entries.length > SNAPSHOT_MAX_FILES) return null;
  }
  const tree = createHash("sha256");
  const files: ReadTree["files"] = [];
  let bytes = 0;
  for (const entry of entries) {
    const data = await readDesignFileSafe(entry.abs, SNAPSHOT_MAX_BYTES);
    bytes += data.length;
    // A file can grow between the walk and the read; the budget is on what was read.
    if (bytes > SNAPSHOT_MAX_BYTES) return null;
    const fileHash = createHash("sha256").update(data).digest("hex");
    tree.update(`${entry.rel}\0${data.length}\0${fileHash}\n`);
    files.push({ rel: entry.rel, data });
  }
  return { files, bytes, treeHash: tree.digest("hex") };
}

/** Write already-read files under `destRoot`, creating directories as needed. */
export async function writeTreeFiles(destRoot: string, files: ReadTree["files"]): Promise<void> {
  for (const file of files) {
    const dest = join(destRoot, ...file.rel.split("/"));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, file.data);
  }
}

/**
 * Take a snapshot of a design whose lock the caller already holds (restore takes its
 * `pre-restore` this way). `keep` protects ids from this snapshot's pruning.
 *
 * Dedupe compares against the newest snapshot, except that a protected snapshot never
 * dedupes against a `before-edit` one: that pool is evictable, and the state it holds
 * would then survive only as long as the next thirty canvas edits allow.
 */
export async function takeSnapshotLocked(
  designDir: string,
  reason: DesignSnapshotReason,
  meta: SnapshotMeta = {},
  keep: ReadonlySet<string> = new Set(),
): Promise<SnapshotResult> {
  const tree = await readDesignTree(designDir);
  if (!tree) {
    console.warn(`[design] not snapshotting ${designDir}: over ${SNAPSHOT_MAX_BYTES / 1024 / 1024} MB or ${SNAPSHOT_MAX_FILES} files`);
    return { skipped: "too-large" };
  }
  const history = await readSnapshotHistory(designDir);
  const newest = history[0];
  if (newest && newest.treeHash === tree.treeHash && (newest.reason !== "before-edit" || reason === "before-edit")) {
    return { skipped: "unchanged", sameAs: newest.id };
  }

  const historyRoot = await ensureHistoryDir(designDir);
  // Strictly after the newest one, so two snapshots within a millisecond still have an order.
  const createdMs = Math.max(Date.now(), newest ? Date.parse(newest.createdAt) + 1 : 0);
  const id = await newSnapshotId(designDir, new Date(createdMs));
  const staging = join(historyRoot, `.tmp-${id}`);
  const info: DesignSnapshotInfo = {
    id,
    reason,
    createdAt: new Date(createdMs).toISOString(),
    ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
    ...(meta.restoreOf ? { restoreOf: meta.restoreOf } : {}),
    fileCount: tree.files.length,
    bytes: tree.bytes,
    treeHash: tree.treeHash,
  };
  try {
    await mkdir(join(staging, SNAPSHOT_FILES), { recursive: true });
    await writeTreeFiles(join(staging, SNAPSHOT_FILES), tree.files);
    await writeFile(join(staging, SNAPSHOT_META), `${JSON.stringify(info, null, 2)}\n`);
    // Published by one rename, so a listed snapshot is always complete.
    await rename(staging, join(historyRoot, id));
  } catch (e) {
    await rm(staging, { recursive: true, force: true });
    throw e;
  }
  await pruneSnapshotHistory(designDir, [info, ...history], keep);
  return { id };
}

/**
 * Snapshot a design (`turn` after an AI turn, `before-edit` ahead of a canvas write-back,
 * `manual` on request). Announces the change with one `history_changed` event when a
 * snapshot was actually taken. A design that does not exist is reported as skipped, since
 * a turn can end in a session whose design was deleted.
 */
export async function snapshotDesign(
  projectPath: string,
  slug: string,
  reason: DesignSnapshotReason,
  meta: SnapshotMeta = {},
): Promise<SnapshotResult> {
  if (!(DESIGN_SNAPSHOT_REASONS as readonly string[]).includes(reason)) {
    throw new DesignError(400, "EBADREASON", `Unknown snapshot reason: ${reason}`);
  }
  let result: SnapshotResult;
  try {
    result = await withRecoveredDesign(projectPath, slug, (dir) => takeSnapshotLocked(dir, reason, meta));
  } catch (e) {
    if (isDesignError(e) && e.status === 404) return { skipped: "missing" };
    throw e;
  }
  if ("id" in result) emitDesignEvent("history_changed", { projectPath: resolve(projectPath), slug });
  return result;
}

/** Snapshots of one design, newest first. */
export async function listSnapshots(projectPath: string, slug: string): Promise<DesignSnapshotInfo[]> {
  return readSnapshotHistory(await resolveDesignDir(projectPath, slug));
}
