/**
 * Where a script schedule's files live: `<ppm dir>/schedule-runs/<db name>/<schedule id>/`.
 * The database name is in the path because the dev server (`ppm.dev.db`) shares the PPM
 * directory with production, and schedule ids of the two databases collide.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getDbPath } from "../db.service.ts";
import { getPpmDir } from "../ppm-dir.ts";

const SCRIPT_FILE = /^script-[0-9a-f]{12}\.mjs$/;

export function scheduleRunDir(scheduleId: number): string {
  return join(getPpmDir(), "schedule-runs", basename(getDbPath()).replace(/\.db$/, ""), String(scheduleId));
}

/**
 * The script as a module file the child imports, named by its content so a run never picks up
 * an edit made while it starts. Older versions are removed; only one child runs per schedule,
 * and it has imported its file before an edit can restart it.
 */
export function writeScriptFile(scheduleId: number, source: string): string {
  const dir = scheduleRunDir(scheduleId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `script-${createHash("sha256").update(source).digest("hex").slice(0, 12)}.mjs`;
  const file = join(dir, name);
  if (!existsSync(file)) writeFileSync(file, source, { mode: 0o600 });
  for (const old of readdirSync(dir)) {
    if (old !== name && SCRIPT_FILE.test(old)) rmSync(join(dir, old), { force: true });
  }
  return file;
}

export function removeRunDir(scheduleId: number): void {
  rmSync(scheduleRunDir(scheduleId), { recursive: true, force: true });
}
