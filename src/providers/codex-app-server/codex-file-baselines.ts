/**
 * The "before" of every file a codex patch changed, kept for the session's review, and the
 * patch's two states of each file in its history (`session-file-history.ts`).
 *
 * Codex applies a patch before PPM hears of it, so unlike a Claude tool there is no moment
 * to read the file first. The completed item carries enough to work it out instead: an added
 * file did not exist, a deleted file's content is in the item, and an update's unified diff
 * run backwards over the file now on disk gives the file it replaced. That last one is checked
 * line by line; a file something else has written since is left to the review's git fallback,
 * and its history gets only the state after the patch, which names no call.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { readBaseline, recordBaseline } from "../../services/session-file-baselines/session-file-baselines.service.ts";
import { reverseUnifiedDiff } from "../../services/session-file-baselines/reverse-unified-diff.ts";
import { observeFile } from "../../services/session-file-baselines/session-file-history.ts";
import { noteFileToolWrite } from "../../services/session-file-baselines/shell-change-tracker.ts";
import { fileUpdateChanges } from "./codex-patch.ts";

/** Resolves once the patch's states are in the history; the baselines are kept before it returns. */
export function recordFileChangeBaselines(sessionId: string, item: unknown, cwd?: string): Promise<void> {
  const it = (item ?? {}) as { type?: unknown; status?: unknown; changes?: unknown; id?: unknown };
  if (it.type !== "fileChange") return Promise.resolve();
  const status = it.status as { type?: string } | string | undefined;
  if ((typeof status === "object" ? status?.type : status) !== "completed") return Promise.resolve();
  const call = typeof it.id === "string" ? it.id : "";
  const observed: Promise<void>[] = [];
  for (const change of fileUpdateChanges(it.changes)) {
    const path = isAbsolute(change.path) || !cwd ? change.path : resolve(cwd, change.path);
    noteFileToolWrite(sessionId, path);
    let before: string | null | undefined;
    if (change.op === "add") {
      before = null;
    } else if (change.op === "delete") {
      before = change.oldString;
    } else if (change.unifiedDiff && !change.movePath) {
      try {
        before = reverseUnifiedDiff(readFileSync(path, "utf8"), change.unifiedDiff) ?? undefined;
      } catch { /* gone again already: nothing to work it out from */ }
    }
    if (before !== undefined && !readBaseline(sessionId, path)) recordBaseline(sessionId, path, before);
    if (!call) continue;
    if (before !== undefined) observed.push(observeFile(sessionId, path, call, "before", before));
    observed.push(observeFile(sessionId, path, call, "after"));
  }
  return Promise.all(observed).then(() => {});
}
