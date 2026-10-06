/**
 * Which change blocks of a file the user kept, for the block-by-block session review.
 *
 * A block is named by its key (`src/shared/review-blocks.ts`), which is only meaningful
 * against the base the block was cut from — the file's "before", or the state it was marked
 * reviewed in — so the record carries that base's hash and is ignored once the base moves.
 * Reverted blocks need no record: a revert writes the base's lines back, so the block is no
 * longer a change at all.
 *
 * Layout: `<session dir>/reviewed/<sha256 of the path>.blocks.json`, beside the file's
 * reviewed mark, replaced (renamed over) on every answer and read along the session's
 * lineage as marks are.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { recordFile, sessionDir } from "./session-file-baselines.service.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("session-review");

export interface BlockAnswers {
  /** Absolute path. */
  path: string;
  /** SHA-256 of the text the blocks were cut against. */
  baseHash: string;
  /** Keys of the blocks kept. */
  kept: string[];
  at: string;
}

export function hashBase(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The session's own records an answer about `filePath` can change: its review mark, then its
 * kept blocks. Undo puts both back as they were.
 */
export function answerRecordFiles(sessionId: string, filePath: string): [mark: string, blocks: string] | null {
  const dir = sessionDir(sessionId);
  if (!dir) return null;
  const mark = recordFile(join(dir, "reviewed"), resolve(filePath));
  return [mark, mark.replace(/\.json$/, ".blocks.json")];
}

function answersFile(sessionId: string, path: string): string | null {
  return answerRecordFiles(sessionId, path)?.[1] ?? null;
}

function readAnswers(sessionId: string, path: string): BlockAnswers | null {
  const file = answersFile(sessionId, path);
  if (!file) return null;
  try {
    const rec = JSON.parse(readFileSync(file, "utf8")) as BlockAnswers;
    return typeof rec?.baseHash === "string" && Array.isArray(rec.kept) ? rec : null;
  } catch {
    return null;
  }
}

/** The kept blocks in force for `filePath` against a base hashing to `baseHash`: the nearest record along `chain`. */
export function keptBlocks(chain: string[], filePath: string, baseHash: string): Set<string> {
  const path = resolve(filePath);
  for (const id of chain) {
    const rec = readAnswers(id, path);
    if (rec) return new Set(rec.baseHash === baseHash ? rec.kept : []);
  }
  return new Set();
}

/** Replace the session's record for `filePath`. False when it could not be written. */
export function writeKeptBlocks(sessionId: string, filePath: string, baseHash: string, kept: Iterable<string>): boolean {
  const path = resolve(filePath);
  const file = answersFile(sessionId, path);
  if (!file) return false;
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(join(file, ".."), { recursive: true });
    const rec: BlockAnswers = { path, baseHash, kept: [...new Set(kept)], at: new Date().toISOString() };
    writeFileSync(tmp, JSON.stringify(rec));
    renameSync(tmp, file);
    return true;
  } catch (e) {
    rmSync(tmp, { force: true });
    // The caller answers "Could not save the answer" inside a 200: the user's answer is lost.
    log.error(`block answers failed for ${path} (session ${sessionId}): ${(e as Error).message}`);
    return false;
  }
}
