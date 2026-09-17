/**
 * Moving a conversation's transcript into the CODEX_HOME that is about to serve it.
 *
 * Codex resolves a thread only against its OWN sessions directory. The `path` argument to
 * `thread/resume` looks like an escape from that, and it is not: a path outside the running
 * app-server's CODEX_HOME is refused with the same "no rollout found for thread id" as
 * passing no path at all. Verified directly — the identical request succeeds when the
 * app-server runs on the home the rollout lives in, and fails when it runs on another.
 *
 * So a session that changes account — because the user picked a different one, or because a
 * usage limit forced the move — has its history sitting in a directory the new account's
 * app-server will not look in, and resuming it is impossible until the file is there. It
 * gets copied rather than moved: the account it came from may still be serving other
 * sessions whose own history sits in the same tree, and the original is what PPM reads for
 * any view of the conversation that is not this live thread.
 *
 * From here codex appends to the copy, so the newest history is in the account now serving
 * the session — which is why `codexSessionsDirs` searches the bound account's directory
 * first.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** Case-insensitive on win32, so two spellings of one directory compare equal. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  return norm(a) === norm(b);
}

/**
 * Ensure a rollout is inside `targetSessionsDir`, and return the path to use.
 *
 * A rollout already in the target directory is returned untouched — the common case, where
 * the session is still on the account that wrote it, and nothing should be copied.
 *
 * The relative layout is preserved (`YYYY/MM/DD/rollout-….jsonl`) because that is where
 * codex's own scan expects to find it.
 *
 * Failures are surfaced rather than swallowed: the caller's next act is a resume that
 * cannot work without this, and a silent failure there turns into a conversation that
 * quietly starts over as a new thread.
 */
export function localizeRollout(
  rolloutPath: string,
  foundInSessionsDir: string,
  targetSessionsDir: string,
): string {
  if (samePath(foundInSessionsDir, targetSessionsDir)) return rolloutPath;
  const dest = join(targetSessionsDir, relative(foundInSessionsDir, rolloutPath));
  if (existsSync(dest)) return dest;
  const destDir = dirname(dest);
  // Only create what is missing. A recursive mkdir over an existing Windows directory
  // carrying the read-only attribute throws EEXIST rather than succeeding quietly.
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
  copyFileSync(rolloutPath, dest);
  return dest;
}
