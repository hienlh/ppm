import { readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanDetail } from "./start-reason.ts";

/**
 * A note the supervisor leaves just before it stops a server on purpose (a restart, a stop, an
 * upgrade, the health check), so the next server can tell a stop someone ordered from a crash.
 *
 * The server's own run log cannot say it: on Windows the supervisor ends the server with
 * TerminateProcess, so the server never runs its shutdown and never writes its stop, and every
 * deliberate restart used to read as "did not shut down cleanly". One file per server pid, in the
 * PPM folder: the folder is shared by `ppm.db` and `ppm.dev.db`, and the pid is what the next start
 * matches against its own database's previous run, so a dev server never wears the live one's note.
 *
 * Kept free of anything but `node:fs`: the supervisor imports it.
 */

const PREFIX = ".server-stop.";
/** Notes no start ever matched (another instance's, a pid whose run log was lost) go after this. */
export const ORDERED_STOP_MAX_AGE_MS = 24 * 60 * 60_000;

const notePath = (ppmDir: string, pid: number) => resolve(ppmDir, `${PREFIX}${pid}.json`);

/** Written by the supervisor right before it stops server `pid`. Never throws. */
export function writeOrderedStop(ppmDir: string, pid: number | undefined, why: string, now = Date.now()): void {
  if (!pid || pid <= 0) return;
  try {
    const file = notePath(ppmDir, pid);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ pid, at: now, why: cleanDetail(why) ?? "stopped by the supervisor" }), { mode: 0o600 });
    renameSync(tmp, file);
  } catch { /* the next start then reads the stop as unexplained, as it did before */ }
}

/**
 * Takes back the note for server `pid`: the stop it announced did not happen (the kill failed and the
 * server went on answering). Left behind, it would excuse that server's next, real crash. Never throws.
 */
export function dropOrderedStop(ppmDir: string, pid: number | undefined): void {
  if (!pid || pid <= 0) return;
  try { unlinkSync(notePath(ppmDir, pid)); } catch { /* none was written, or the next start took it */ }
}

/**
 * Why the supervisor stopped the run `pid` that started at `startedAt`, consumed; null when it
 * left no note for that run. Stale notes for other pids are removed on the way.
 */
export function takeOrderedStop(ppmDir: string, run: { pid: number; startedAt: number }, now = Date.now()): string | null {
  let found: string | null = null;
  let names: string[] = [];
  try { names = readdirSync(ppmDir); } catch { return null; }
  for (const name of names) {
    if (!name.startsWith(PREFIX) || !name.endsWith(".json")) continue;
    const file = resolve(ppmDir, name);
    if (name === `${PREFIX}${run.pid}.json`) {
      try {
        const note = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown; at?: unknown; why?: unknown };
        // A note older than the run is a previous holder of the same pid's.
        if (note.pid === run.pid && typeof note.at === "number" && note.at >= run.startedAt) found = cleanDetail(note.why) ?? "stopped by the supervisor";
      } catch { /* unreadable: not trusted */ }
      try { unlinkSync(file); } catch { /* gone already */ }
      continue;
    }
    try {
      if (now - statSync(file).mtimeMs > ORDERED_STOP_MAX_AGE_MS) unlinkSync(file);
    } catch { /* another process took it */ }
  }
  return found;
}
