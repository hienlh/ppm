/**
 * "Reviewed" marks for the session review: the state a file was in when the user marked it
 * reviewed. The list hides a file while it is still in that state, and once the agent changes
 * it again diffs it against that state, so only what is new is left to read (Cursor's Keep).
 *
 * Layout: `<session dir>/reviewed/<sha256 of the path>.json`, beside the session's "before"
 * copies and deleted and pruned with them. Unlike a "before", a mark is replaced each time it
 * is set (renamed over, so a reader never sees half of one). Unmarking writes a `cleared`
 * record instead of removing the file: marks are read along the session's lineage, as its
 * "before"s are, and a removed record would let a parent's mark show through again.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { recordFile, sessionDir } from "./session-file-baselines.service.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("session-review");

export interface ReviewMark {
  /** Absolute path. */
  path: string;
  /** False when the file did not exist: a deletion was reviewed. */
  existed: boolean;
  /** The text as marked, to diff what changed since; absent for a binary or oversized file. */
  content?: string;
  binary?: boolean;
  tooLarge?: boolean;
  /** SHA-256 of the bytes as marked; absent for a file over the size cap, which is never read. */
  hash?: string;
  /** Size and modification time as marked: all there is to tell an oversized file's states apart. */
  version?: string;
  /** On the record that undoes a mark. */
  cleared?: true;
  markedAt: string;
}

function marksDir(sessionId: string): string | null {
  const dir = sessionDir(sessionId);
  return dir ? join(dir, "reviewed") : null;
}

function readRecord(sessionId: string, path: string): ReviewMark | null {
  const dir = marksDir(sessionId);
  if (!dir) return null;
  try {
    const rec = JSON.parse(readFileSync(recordFile(dir, path), "utf8")) as ReviewMark;
    return typeof rec?.path === "string" && typeof rec.existed === "boolean" ? rec : null;
  } catch {
    return null;
  }
}

/**
 * The mark in force for `filePath`: the nearest record along `chain` (the session first, then
 * the sessions it was branched from), or null when there is none or the nearest was cleared.
 */
export function findReviewMark(chain: string[], filePath: string): ReviewMark | null {
  const path = resolve(filePath);
  for (const id of chain) {
    const rec = readRecord(id, path);
    if (rec) return rec.cleared ? null : rec;
  }
  return null;
}

/** Replace the session's record for `mark.path`. False when it could not be written. */
export function writeReviewMark(sessionId: string, mark: Omit<ReviewMark, "markedAt">): boolean {
  const dir = marksDir(sessionId);
  if (!dir) return false;
  const path = resolve(mark.path);
  const file = recordFile(dir, path);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify({ ...mark, path, markedAt: new Date().toISOString() }));
    renameSync(tmp, file);
    return true;
  } catch (e) {
    rmSync(tmp, { force: true });
    // The caller answers "Could not save the answer" inside a 200: the user's answer is lost.
    log.error(`mark failed for ${path} (session ${sessionId}): ${(e as Error).message}`);
    return false;
  }
}

/** Undo the mark in force for `filePath`, if there is one. True when this call undid it. */
export function clearReviewMark(sessionId: string, chain: string[], filePath: string): boolean {
  return !!findReviewMark(chain, filePath) && writeReviewMark(sessionId, { path: filePath, existed: false, cleared: true });
}
