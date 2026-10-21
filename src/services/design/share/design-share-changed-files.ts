import { createHash } from "node:crypto";
import { SHARE_LIMITS, type DesignShareChangedFiles } from "../../../shared/design-share-types.ts";
import { readSnapshotInfo, snapshotFilesDir } from "../design-snapshot-history.ts";
import { readDesignTree } from "../design-snapshots.service.ts";
import { shareError } from "./design-share-link-rules.ts";

/**
 * Which files a share link's reviewers would see differently: between two snapshots (after a
 * re-pin), or between the pinned snapshot and the live design (before one).
 *
 * Both sides are read with {@link readDesignTree}, the walk a snapshot itself takes: same
 * `.design/` exclusion, same symlink and credential refusals, same size and file caps. So the
 * live side lists exactly what "Update to latest" would pin.
 */

/** sha256 of every file under `root`, by path relative to it; null when over the snapshot caps. */
async function treeFileHashes(root: string): Promise<Map<string, string> | null> {
  const tree = await readDesignTree(root);
  if (!tree) return null;
  return new Map(tree.files.map((f) => [f.rel, createHash("sha256").update(f.data).digest("hex")]));
}

/** Added, removed and changed paths, at most {@link SHARE_LIMITS.maxChangedFiles} names in all. */
function diffHashes(before: Map<string, string>, after: Map<string, string>): DesignShareChangedFiles {
  const out: DesignShareChangedFiles = { added: [], removed: [], changed: [], truncated: false };
  let listed = 0;
  const add = (list: string[], rel: string) => {
    if (listed >= SHARE_LIMITS.maxChangedFiles) {
      out.truncated = true;
      return;
    }
    list.push(rel);
    listed++;
  };
  for (const rel of [...after.keys()].sort()) {
    const was = before.get(rel);
    if (was === undefined) add(out.added, rel);
    else if (was !== after.get(rel)) add(out.changed, rel);
  }
  for (const rel of [...before.keys()].sort()) {
    if (!after.has(rel)) add(out.removed, rel);
  }
  return out;
}

/** A stored snapshot's file hashes; a snapshot is within the caps by construction. */
async function snapshotHashes(designDir: string, id: string): Promise<Map<string, string>> {
  const hashes = await treeFileHashes(snapshotFilesDir(designDir, id));
  if (!hashes) throw shareError(409, "too-large", "The pinned version is too large to compare");
  return hashes;
}

/**
 * What a reviewer will see differently after a link moves from `oldId` to `newId`.
 * Null when either snapshot is gone, since there is then nothing to compare with.
 */
export async function diffSnapshotFiles(designDir: string, oldId: string, newId: string): Promise<DesignShareChangedFiles | null> {
  if (oldId === newId) return { added: [], removed: [], changed: [], truncated: false };
  if (!(await readSnapshotInfo(designDir, oldId)) || !(await readSnapshotInfo(designDir, newId))) return null;
  const [before, after] = await Promise.all([snapshotHashes(designDir, oldId), snapshotHashes(designDir, newId)]);
  return diffHashes(before, after);
}

/**
 * What a re-pin of a link pinned to `pinnedId` would change, compared with the live design
 * files. Null when the pinned snapshot is gone. Refused (409 `too-large`) when the live design
 * is over the snapshot caps, as the re-pin itself would be. The caller holds the design lock.
 */
export async function diffSnapshotWithLive(designDir: string, pinnedId: string): Promise<DesignShareChangedFiles | null> {
  if (!(await readSnapshotInfo(designDir, pinnedId))) return null;
  const live = await treeFileHashes(designDir);
  if (!live) throw shareError(409, "too-large", "The design is too large to snapshot, so it cannot be re-pinned");
  return diffHashes(await snapshotHashes(designDir, pinnedId), live);
}
