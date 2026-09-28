import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isSnapshotId } from "../../shared/design-types.ts";
import { ensureDotDesign } from "./design-fs.ts";
import { DesignError } from "./design-error.ts";
import { emitDesignEvent } from "./design-events.ts";
import {
  completeSwap, crashPoint, finishRestore, withRecoveredDesign, writeRestoreJournal, type RestoreJournal,
} from "./design-restore-journal.ts";
import { readSnapshotInfo, snapshotFilesDir } from "./design-snapshot-history.ts";
import { readDesignTree, takeSnapshotLocked, writeTreeFiles } from "./design-snapshots.service.ts";

export { recoverRestoreJournal } from "./design-restore-journal.ts";

export interface RestoreResult {
  restored: string;
  /**
   * Snapshot holding the state from just before the restore, i.e. the one to restore to
   * undo it: the new `pre-restore` snapshot, or the existing snapshot that already equalled
   * the current state.
   */
  previousStateId: string;
}

/**
 * Replace a design's working files with a snapshot's, as a journaled swap.
 *
 *  1. Snapshot the current state (`pre-restore`), protecting the target from that
 *     snapshot's pruning so restoring the oldest entry cannot evict the entry itself.
 *  2. Stage a full copy of the target in `.design/tmp-<id>/`, journal `staged`.
 *  3. Journal `swapping`, then swap (see `completeSwap`).
 *  4. Remove the journal and the empty staging dir.
 *
 * A crash anywhere after step 2 is repaired by the next locked operation on the design.
 * The restore is refused when the current state cannot be snapshotted (over the size
 * budget), because it could then never be undone.
 */
export async function restoreSnapshot(projectPath: string, slug: string, id: string): Promise<RestoreResult> {
  if (!isSnapshotId(id)) throw new DesignError(400, "EBADID", "Invalid snapshot id");
  const result = await withRecoveredDesign(projectPath, slug, async (designDir) => {
    if (!(await readSnapshotInfo(designDir, id))) throw new DesignError(404, "ENOENT", `Snapshot not found: ${id}`);

    const before = await takeSnapshotLocked(designDir, "pre-restore", { restoreOf: id }, new Set([id]));
    if ("skipped" in before && before.skipped !== "unchanged") {
      throw new DesignError(409, "ETOOLARGE", "The current design is too large to back up, so restoring would lose it");
    }
    const previousStateId = "id" in before ? before.id : before.sameAs;

    const staged = await readDesignTree(snapshotFilesDir(designDir, id), { skipDotDesign: true });
    if (!staged) throw new DesignError(409, "ETOOLARGE", "Snapshot is too large to restore");
    const dot = await ensureDotDesign(designDir);
    const journal: RestoreJournal = { id, tmp: `tmp-${id}`, phase: "staged", names: [] };
    const tmpDir = join(dot, journal.tmp);
    try {
      await rm(tmpDir, { recursive: true, force: true });
      await mkdir(tmpDir);
      await writeTreeFiles(tmpDir, staged.files);
      journal.names = await readdir(tmpDir);
    } catch (e) {
      // Nothing is journaled yet, so the working tree is untouched and tmp is disposable.
      await rm(tmpDir, { recursive: true, force: true });
      throw e;
    }
    await writeRestoreJournal(designDir, journal);
    crashPoint("staged");

    journal.phase = "swapping";
    await writeRestoreJournal(designDir, journal);
    crashPoint("swapping");
    await completeSwap(designDir, journal);
    crashPoint("swapped");
    await finishRestore(designDir, journal);
    return { restored: id, previousStateId };
  });
  emitDesignEvent("history_changed", { projectPath: resolve(projectPath), slug });
  return result;
}
