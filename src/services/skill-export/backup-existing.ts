// Rename existing skill files to `.bak-<timestamp>` before overwriting.
// Preserves earlier backups by embedding a UTC timestamp in the suffix.
import { existsSync, renameSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

/** Produce a compact UTC timestamp like `202604211733` (YYYYMMDDHHmm). */
export function makeTimestamp(d: Date = new Date()): string {
  return d.toISOString().replace(/[-:T]/g, "").slice(0, 12);
}

export function backupExisting(targetDir: string, ts: string = makeTimestamp()): string[] {
  if (!existsSync(targetDir)) return [];
  const backedUp: string[] = [];
  walkAndBackup(targetDir, ts, backedUp);
  return backedUp;
}

function walkAndBackup(dir: string, ts: string, collected: string[]): void {
  const entries = readdirSync(dir);
  for (const name of entries) {
    // Skip already-backed-up files to avoid `.md.bak-X.bak-Y` chains.
    if (name.includes(".bak-")) continue;
    const abs = resolve(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      walkAndBackup(abs, ts, collected);
    } else if (st.isFile() && name.endsWith(".md")) {
      const dest = `${abs}.bak-${ts}`;
      renameSync(abs, dest);
      collected.push(dest);
    }
  }
}
