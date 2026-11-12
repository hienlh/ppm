import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sessionDir } from "./session-file-baselines.service.ts";

/**
 * What one review answer's Undo would touch, read from the journal the answer wrote
 * (`<session dir>/undo/<id>.json`, see `session-review-actions.ts`) without acting on it: the
 * card asking to undo it names the files from PPM's own record, never from the agent's words.
 */

export interface UndoRecordSummary {
  createdAt: string;
  files: Array<{
    path: string;
    /** The answer wrote the file on disk (a revert); otherwise it moved only the review marks. */
    wroteFile: boolean;
  }>;
}

const UNDO_ID = /^[0-9a-f-]{36}$/;

/** The journal of answer `undoId` in the session, or null when there is none (or it has expired). */
export function readUndoRecord(sessionId: string, undoId: string): UndoRecordSummary | null {
  const dir = sessionDir(sessionId);
  if (!dir || !UNDO_ID.test(undoId)) return null;
  try {
    const record = JSON.parse(readFileSync(join(dir, "undo", `${undoId}.json`), "utf8")) as {
      createdAt?: unknown;
      entries?: Array<{ path?: unknown; revert?: unknown }>;
    };
    if (!Array.isArray(record.entries)) return null;
    const files = record.entries
      .filter((e) => typeof e?.path === "string")
      .map((e) => ({ path: e.path as string, wroteFile: !!e.revert }));
    return { createdAt: typeof record.createdAt === "string" ? record.createdAt : "", files };
  } catch {
    return null;
  }
}
