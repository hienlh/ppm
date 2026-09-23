import { readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { isSnapshotId } from "../../shared/design-types.ts";
import { DOT_DESIGN, dotDesignDir, lstatOrNull, resolveDesignDir } from "./design-paths.ts";
import { writeFileAtomic } from "./design-fs.ts";
import { designLockKey, withDesignLock } from "./design-lock.ts";

/**
 * The crash-safety half of restore.
 *
 * A restore replaces the design's working files with a snapshot's. It stages a full copy
 * in `.design/tmp-<id>/`, records `.design/restore-journal.json`, and only then swaps:
 *
 *   staged   → the working tree is untouched; recovery discards the staged copy.
 *   swapping → the working tree may be half replaced; recovery *finishes* the swap from
 *              tmp, which by then is the only full copy of the target state, and is never
 *              deleted before the swap completes.
 *
 * Both the live restore and recovery go through {@link completeSwap}, which is idempotent:
 * each top-level entry is moved by one `rename`, so it sits either in tmp or in the working
 * tree, and the journal's `names` (the staged top-level names) tells the two apart after a
 * crash. A working entry that is also still in tmp is the old version; a staged name that
 * is no longer in tmp has already been moved in and is kept.
 */

export const RESTORE_JOURNAL = "restore-journal.json";
const TMP_PREFIX = "tmp-";

export interface RestoreJournal {
  id: string;
  /** Staging directory name under `.design/`, always `tmp-<id>`. */
  tmp: string;
  phase: "staged" | "swapping";
  /** Top-level entry names of the staged copy. */
  names: string[];
}

/** Test seam: called after each durable step so a test can "crash" there by throwing. */
export const restoreCrashPoints: { hit?: (step: string) => void } = {};

export function crashPoint(step: string): void {
  restoreCrashPoints.hit?.(step);
}

function isPlainName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.length <= 255
    && name !== "." && name !== ".." && name !== DOT_DESIGN && !/[\\/\0]/.test(name);
}

function parseJournal(raw: string): RestoreJournal | null {
  let data: Partial<RestoreJournal>;
  try {
    data = JSON.parse(raw) as Partial<RestoreJournal>;
  } catch {
    return null;
  }
  if (!data || !isSnapshotId(data.id) || data.tmp !== `${TMP_PREFIX}${data.id}`) return null;
  if (data.phase !== "staged" && data.phase !== "swapping") return null;
  if (!Array.isArray(data.names) || !data.names.every(isPlainName)) return null;
  return { id: data.id, tmp: data.tmp, phase: data.phase, names: data.names };
}

export async function writeRestoreJournal(designDir: string, journal: RestoreJournal): Promise<void> {
  await writeFileAtomic(join(dotDesignDir(designDir), RESTORE_JOURNAL), `${JSON.stringify(journal)}\n`);
}

/**
 * Make the working tree equal the staged copy. Safe to call again after any crash inside
 * it, and after it has fully completed.
 */
export async function completeSwap(designDir: string, journal: RestoreJournal): Promise<void> {
  const tmpDir = join(dotDesignDir(designDir), journal.tmp);
  const staged = new Set(journal.names);
  const inTmp = new Set(await readdir(tmpDir).catch(() => [] as string[]));
  for (const name of await readdir(designDir)) {
    if (name === DOT_DESIGN) continue;
    if (staged.has(name) && !inTmp.has(name)) continue; // already moved in by an earlier attempt
    // rm removes a symlink itself, never what it points to.
    await rm(join(designDir, name), { recursive: true, force: true });
    crashPoint(`cleared:${name}`);
  }
  for (const name of [...inTmp].sort()) {
    if (!staged.has(name)) continue; // not part of the staged copy; left for cleanup below
    await rename(join(tmpDir, name), join(designDir, name));
    crashPoint(`moved:${name}`);
  }
}

/** Journal first, then the (now empty) staging dir: a crash between leaves only a stale tmp. */
export async function finishRestore(designDir: string, journal: RestoreJournal): Promise<void> {
  await rm(join(dotDesignDir(designDir), RESTORE_JOURNAL), { force: true });
  await rm(join(dotDesignDir(designDir), journal.tmp), { recursive: true, force: true });
}

export type RecoveryOutcome = "none" | "discarded" | "completed";

/**
 * Bring a design back to a consistent state after a restore that did not finish. Runs at
 * the start of every locked design operation, so the next snapshot, restore or edit after
 * a crash sees either the old tree or the restored one — never a mix.
 */
export async function recoverRestoreJournal(designDir: string): Promise<RecoveryOutcome> {
  const dot = dotDesignDir(designDir);
  const dotSt = await lstatOrNull(dot);
  if (!dotSt || dotSt.isSymbolicLink() || !dotSt.isDirectory()) return "none";
  const journalPath = join(dot, RESTORE_JOURNAL);
  const raw = (await lstatOrNull(journalPath))?.isFile() ? await readFile(journalPath, "utf8") : null;
  const journal = raw === null ? null : parseJournal(raw);
  if (journal?.phase === "swapping") {
    await completeSwap(designDir, journal);
    await finishRestore(designDir, journal);
    console.warn(`[design] finished an interrupted restore of ${journal.id} in ${designDir}`);
    return "completed";
  }
  if (raw !== null) {
    if (!journal) console.warn(`[design] ignoring an unreadable restore journal in ${designDir}`);
    await rm(journalPath, { force: true });
  }
  // Staged copies with no journal left to say they matter: a staged-phase crash, or a crash
  // between removing a finished journal and its empty staging dir. `.tmp-` files are
  // atomic writes (journal, manifest) cut short by a crash.
  for (const name of await readdir(dot)) {
    if (name.startsWith(TMP_PREFIX) || name.startsWith(".tmp-")) await rm(join(dot, name), { recursive: true, force: true });
  }
  return journal?.phase === "staged" ? "discarded" : "none";
}

/**
 * Run `fn` on a design under its lock, after resolving (and guarding) its folder and
 * recovering any interrupted restore. The entry point for every operation that modifies a
 * design's files or its `.design/` data.
 */
export async function withRecoveredDesign<T>(
  projectPath: string,
  slug: string,
  fn: (designDir: string) => Promise<T>,
): Promise<T> {
  return withDesignLock(designLockKey(projectPath, slug), async () => {
    const designDir = await resolveDesignDir(projectPath, slug);
    await recoverRestoreJournal(designDir);
    return fn(designDir);
  });
}
