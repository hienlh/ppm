/**
 * Keeping `ppm.log` bounded, and keeping one line out of it twice.
 *
 * Two separate defects sat in the same file. On this machine it had reached
 * **276 MB / 1,395,012 lines**, and of those only 532,792 carried the
 * `[timestamp] [LEVEL]` prefix — the other 862,220 (62%) were the *same events*
 * arriving by a second route.
 *
 * The second route is `supervisor.ts` spawning the server with
 * `stdio: ["ignore", logFd, logFd]`, where `logFd` is `ppm.log` itself. So the
 * server's own `console.log` already lands in the log through fd 1, and
 * `setupLogFile()` then appends a formatted copy of the same line. That is the
 * duplication — and it is not a harmless one, because only the appended copy
 * goes through `redactSecrets()`. The raw stdout copy does not, which is how
 * two lines matching `Token: <value>` are sitting in the log right now. The
 * redaction was never wrong; it only ever covered one of the two doors.
 *
 * `fdWritesTo` is how a writer notices that its own stdout already reaches the
 * file it was about to append to, so it can stop doing one of the two.
 */

import { fstatSync, statSync, copyFileSync, truncateSync, renameSync, rmSync, existsSync } from "node:fs";

/** Rotate once the log passes this. */
export const MAX_LOG_BYTES = 20 * 1024 * 1024;

/** How many previous logs to keep (`ppm.log.1` … `ppm.log.3`). */
export const LOG_GENERATIONS = 3;

/**
 * Whether writing to `fd` lands in `filePath` — same inode, same device.
 *
 * Answers "is my stdout already this log file?", which is the only way a
 * process started by the supervisor can tell that appending would duplicate.
 *
 * Returns false whenever it cannot be sure. An inode of 0 is what Windows
 * reports for most handles, so there the answer is always "not the same file"
 * and both writers keep their existing behaviour rather than one of them
 * silently going quiet.
 */
export function fdWritesTo(fd: number, filePath: string): boolean {
  try {
    const a = fstatSync(fd);
    if (a.ino === 0) return false;
    const b = statSync(filePath);
    return a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}

/**
 * Truncate the log in place once it is oversized, keeping N previous copies.
 *
 * In place, and that is the whole design constraint: both the supervisor and
 * the server child hold file descriptors opened on this inode with `O_APPEND`.
 * Renaming the file would leave every one of those descriptors writing into the
 * renamed file for the rest of the process's life — the log would appear to
 * rotate and then never grow again, while `ppm.log.1` quietly became the real
 * log. Copying the contents out and truncating the original keeps the inode,
 * so an `O_APPEND` writer simply resumes at offset 0.
 *
 * The cost is the one `logrotate` calls `copytruncate` and accepts for the same
 * reason: a line written between the copy and the truncate is lost. The window
 * is a few milliseconds, once per `maxBytes` of log.
 *
 * Returns whether it rotated.
 */
export function rotateIfOversized(
  filePath: string,
  maxBytes: number = MAX_LOG_BYTES,
  generations: number = LOG_GENERATIONS,
): boolean {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return false; // no log yet
  }
  if (size <= maxBytes) return false;

  try {
    // Oldest first, or a shift would overwrite the generation it is about to move.
    rmSync(`${filePath}.${generations}`, { force: true });
    for (let i = generations - 1; i >= 1; i--) {
      const from = `${filePath}.${i}`;
      if (existsSync(from)) renameSync(from, `${filePath}.${i + 1}`);
    }
    copyFileSync(filePath, `${filePath}.1`);
    truncateSync(filePath, 0);
    return true;
  } catch {
    // A log that cannot be rotated must not take the process with it.
    return false;
  }
}
