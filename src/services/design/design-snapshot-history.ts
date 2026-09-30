import { randomBytes } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  DESIGN_SNAPSHOT_REASONS, isSnapshotId, type DesignSnapshotInfo, type DesignSnapshotReason,
} from "../../shared/design-types.ts";
import { dotDesignDir, lstatOrNull } from "./design-paths.ts";
import { ensureDotDesign, mkdirIfMissing } from "./design-fs.ts";

/**
 * On-disk layout of a design's snapshot history:
 *
 *   designs/<slug>/.design/history/<id>/meta.json
 *   designs/<slug>/.design/history/<id>/files/<the design's files>
 *
 * A snapshot is written under `history/.tmp-<id>/` and renamed into place when complete,
 * so a listed snapshot is always whole; a crash leaves only a `.tmp-` directory, which
 * pruning removes.
 */

export const HISTORY_DIR = "history";
export const SNAPSHOT_META = "meta.json";
export const SNAPSHOT_FILES = "files";

/** Newest `turn`, `pre-restore` and `manual` snapshots kept, together. */
export const SNAPSHOT_CAP = 100;
/** Newest `before-edit` snapshots kept, in a pool of their own so they cannot evict real history. */
export const EDIT_SNAPSHOT_CAP = 30;

const MAX_META_BYTES = 64 * 1024;

export function historyDir(designDir: string): string {
  return join(dotDesignDir(designDir), HISTORY_DIR);
}

export function snapshotDir(designDir: string, id: string): string {
  return join(historyDir(designDir), id);
}

export function snapshotFilesDir(designDir: string, id: string): string {
  return join(snapshotDir(designDir, id), SNAPSHOT_FILES);
}

function isReason(value: unknown): value is DesignSnapshotReason {
  return typeof value === "string" && (DESIGN_SNAPSHOT_REASONS as readonly string[]).includes(value);
}

/** Parse a meta.json, refusing anything that does not describe the directory it sits in. */
function parseMeta(raw: string, id: string): DesignSnapshotInfo | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || data.id !== id || !isReason(data.reason)) return null;
  if (typeof data.createdAt !== "string" || Number.isNaN(Date.parse(data.createdAt))) return null;
  if (typeof data.fileCount !== "number" || typeof data.bytes !== "number") return null;
  if (typeof data.treeHash !== "string" || !/^[0-9a-f]{64}$/.test(data.treeHash)) return null;
  return {
    id,
    reason: data.reason,
    createdAt: data.createdAt,
    ...(typeof data.sessionId === "string" ? { sessionId: data.sessionId } : {}),
    ...(isSnapshotId(data.restoreOf) ? { restoreOf: data.restoreOf } : {}),
    fileCount: data.fileCount,
    bytes: data.bytes,
    treeHash: data.treeHash,
  };
}

async function readMeta(designDir: string, id: string): Promise<DesignSnapshotInfo | null> {
  // `.design/` is inside a folder the agent writes to. A snapshot directory that is a
  // symlink is not one this module made, and restoring "from" it would read elsewhere.
  const dirSt = await lstatOrNull(snapshotDir(designDir, id));
  if (!dirSt || dirSt.isSymbolicLink() || !dirSt.isDirectory()) return null;
  const path = join(snapshotDir(designDir, id), SNAPSHOT_META);
  const st = await lstatOrNull(path);
  if (!st || !st.isFile() || st.size > MAX_META_BYTES) return null;
  return parseMeta(await readFile(path, "utf8"), id);
}

/** Every complete snapshot, newest first. Unreadable entries are left out, never guessed at. */
export async function readSnapshotHistory(designDir: string): Promise<DesignSnapshotInfo[]> {
  const st = await lstatOrNull(historyDir(designDir));
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return [];
  let names: string[];
  try {
    names = await readdir(historyDir(designDir));
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return [];
    throw e;
  }
  const infos = await Promise.all(names.filter(isSnapshotId).map((id) => readMeta(designDir, id)));
  return infos
    .filter((info): info is DesignSnapshotInfo => info !== null)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : -1));
}

export async function readSnapshotInfo(designDir: string, id: string): Promise<DesignSnapshotInfo | null> {
  return isSnapshotId(id) ? readMeta(designDir, id) : null;
}

/** `history/`, created (with `.design/` and its `.gitignore`) when missing; never a symlink. */
export async function ensureHistoryDir(designDir: string): Promise<string> {
  await ensureDotDesign(designDir);
  const dir = historyDir(designDir);
  await mkdirIfMissing(dir);
  const st = await lstatOrNull(dir);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) {
    throw Object.assign(new Error(".design/history must be a real directory"), { status: 403, code: "EDESIGNPATH" });
  }
  return dir;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** A fresh `YYYYMMDD-HHMMSS-xxxx` id (UTC) that names nothing in `history/` yet. */
export async function newSnapshotId(designDir: string, now = new Date()): Promise<string> {
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-`
    + `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  for (let attempt = 0; attempt < 64; attempt++) {
    const id = `${stamp}-${randomBytes(2).toString("hex")}`;
    const taken = (await lstatOrNull(snapshotDir(designDir, id)))
      || (await lstatOrNull(join(historyDir(designDir), `.tmp-${id}`)));
    if (!taken) return id;
  }
  throw new Error("Could not allocate a snapshot id");
}

/**
 * Apply retention to a newest-first history: keep the newest {@link SNAPSHOT_CAP} protected
 * snapshots and the newest {@link EDIT_SNAPSHOT_CAP} `before-edit` ones, each pool counted
 * on its own. Ids in `keep` survive regardless (a restore protects its own target while it
 * snapshots the current state). Also clears half-written `.tmp-` directories, which only
 * exist after a crash because every caller holds the design lock. Returns the removed ids.
 */
export async function pruneSnapshotHistory(
  designDir: string,
  history: DesignSnapshotInfo[],
  keep: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const removed: string[] = [];
  let edits = 0;
  let others = 0;
  for (const info of history) {
    const overCap = info.reason === "before-edit" ? ++edits > EDIT_SNAPSHOT_CAP : ++others > SNAPSHOT_CAP;
    if (!overCap || keep.has(info.id)) continue;
    await rm(snapshotDir(designDir, info.id), { recursive: true, force: true });
    removed.push(info.id);
  }
  const names = await readdir(historyDir(designDir)).catch(() => [] as string[]);
  for (const name of names) {
    if (name.startsWith(".tmp-")) await rm(join(historyDir(designDir), name), { recursive: true, force: true });
  }
  return removed;
}
