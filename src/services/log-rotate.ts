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
 * Set by the supervisor on any child it hands `stdio: [\"ignore\", logFd, logFd]`.
 *
 * The inode comparison below cannot answer that question on Windows: `fstat` reports an inode
 * of 0 for most handles there, so `fdWritesTo` says "not the same file" and both writers keep
 * writing — which means the duplicate, **unredacted** stdout copy this module exists to remove
 * was still being written on the one platform PPM is most often installed on. Detection cannot
 * be made to work there, but the process doing the wiring knows for certain, so it says so.
 */
export const STDIO_IS_LOG_ENV = "PPM_STDIO_IS_LOG";

/**
 * Whether console output on `fd` already reaches `filePath` — by what the spawner declared,
 * or, for a process nobody declared anything to, by inode.
 */
export function stdioIsLogFile(fd: number, filePath: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return env[STDIO_IS_LOG_ENV] === "1" || fdWritesTo(fd, filePath);
}

/**
 * Drop the marker once it has been read.
 *
 * It is inherited like any other variable, and PPM spawns terminals, SDK children and
 * `ppm` CLI invocations with its own environment — every one of which would otherwise start
 * life believing its stdout is the log file and silently drop it.
 */
export function consumeStdioIsLogEnv(env: NodeJS.ProcessEnv = process.env): void {
  delete env[STDIO_IS_LOG_ENV];
}

/**
 * Whether writing to `fd` lands in `filePath` — same inode, same device.
 *
 * Answers "is my stdout already this log file?" for a process the supervisor did not label.
 *
 * Returns false whenever it cannot be sure, which on Windows is always — see
 * `STDIO_IS_LOG_ENV`, which is how the supervisor's children get a real answer there.
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
  } catch (e) {
    // A log that cannot be rotated must not take the process with it — but it must not do so
    // in silence either. `truncateSync` on a file the supervisor and the server child both
    // hold open fails with EBUSY on Windows, and a blanket `catch` turned "this log is
    // unbounded from here on" into no signal at all. Once per process, because the caller is
    // a one-minute timer and the second failure says nothing the first did not.
    if (!rotateFailureReported) {
      rotateFailureReported = true;
      console.warn(
        `[log-rotate] Could not rotate ${filePath} (${(e as Error).message}) — it will keep `
        + "growing past its cap. On Windows this is usually another process holding the file open.",
      );
    }
    return false;
  }
}

/** One warning per process; see the `catch` above. Exported for tests, which need to be able
 *  to observe the *first* failure rather than whichever one happens to run first. */
export function resetRotateFailureWarning(): void {
  rotateFailureReported = false;
}

let rotateFailureReported = false;
