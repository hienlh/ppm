import { Command } from "commander";

/**
 * `ppm backup` / `ppm restore` — manual control over config-database
 * snapshots. Snapshots also happen automatically (hourly, at start-up, and
 * before any schema migration); these commands exist for the two moments
 * automation cannot cover: taking one deliberately before a risky change, and
 * getting back on your feet after something ate the database.
 *
 * Kept out of `db-cmd.ts` on purpose — that command group manages *external*
 * database connections, so `ppm db backup` would read as backing one of those
 * up rather than PPM's own store.
 */

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};

function mb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function ago(date: Date, now = new Date()): string {
  const mins = Math.round((now.getTime() - date.getTime()) / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function registerBackupCommands(program: Command): void {
  program
    .command("backup")
    .description("Snapshot the PPM config database now")
    .option("--json", "Output as JSON")
    .action(async (options: { json?: boolean }) => {
      try {
        const { backupDb } = await import("../../services/db-backup/db-backup.service.ts");
        const result = await backupDb("manual");
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`${C.green}Snapshot written${C.reset} ${result.path}`);
        console.log(`  ${mb(result.bytes)} in ${result.ms}ms, integrity verified`);
        if (result.pruned.length) {
          console.log(`  ${C.dim}pruned ${result.pruned.length} older snapshot(s) per retention policy${C.reset}`);
        }
      } catch (e: any) {
        console.error(`${C.red}Backup failed:${C.reset} ${e?.message ?? e}`);
        process.exit(1);
      }
    });

  program
    .command("restore")
    .description("Restore the PPM config database from a snapshot (refused from an AI chat; --list is not)")
    .argument("[backup]", "Snapshot filename or path (default: the newest one)")
    .option("--list", "List available snapshots and exit")
    .option("--force", "Restore even while PPM is running (stop it first when you can)")
    .option("--json", "Output as JSON")
    .action(async (backupArg: string | undefined, options: { list?: boolean; force?: boolean; json?: boolean }) => {
      // Advisory, like every check keyed on the AI-chat mark (the shell's card is the control):
      // a restore replaces every project, chat record, setting and credential PPM keeps, and
      // with --force it does so under a running server. A person runs it.
      if (!options.list && (await import("../../services/ai-chat-env.ts")).inAiChat()) {
        console.error(`${C.red}Restore refused:${C.reset} ppm restore replaces PPM's whole database, so it is refused here from an AI chat. `
          + "Give the user the command to run at their own terminal (`ppm restore --list` shows the snapshots).");
        process.exit(1);
      }
      try {
        const { listBackups, activeDbStem } = await import("../../services/db-backup/db-backup.service.ts");
        const { getBackupsDir } = await import("../../services/db-backup/db-backup-paths.ts");
        const { restoreDb, resolveBackupArg } = await import("../../services/db-backup/db-backup-restore.ts");
        const { getDbPath } = await import("../../services/db.service.ts");

        const stem = await activeDbStem();
        const entries = listBackups(stem);

        if (options.list) {
          if (options.json) {
            console.log(JSON.stringify(entries, null, 2));
            return;
          }
          if (entries.length === 0) {
            console.log(`${C.yellow}No snapshots in ${getBackupsDir()}${C.reset}`);
            return;
          }
          console.log(`${C.bold}Snapshots in ${getBackupsDir()}${C.reset}`);
          for (const e of entries) {
            console.log(`  ${C.cyan}${e.name}${C.reset}  ${mb(e.bytes)}  ${C.dim}${e.reason}, ${ago(e.date)}${C.reset}`);
          }
          return;
        }

        const target = backupArg
          ? resolveBackupArg(backupArg, getBackupsDir())
          : entries[0]?.path;
        if (!target) {
          console.error(`${C.red}No snapshot to restore${C.reset} — nothing in ${getBackupsDir()}`);
          process.exit(1);
          return;
        }

        const result = restoreDb(target, { dbPath: getDbPath(), force: options.force });
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`${C.green}Restored${C.reset} ${result.dbPath} (${mb(result.bytes)})`);
        console.log(`  from ${result.restoredFrom}`);
        if (result.archivedTo) {
          console.log(`  ${C.dim}previous database kept at ${result.archivedTo}${C.reset}`);
        }
        console.log(`  ${C.dim}start PPM with: ppm start${C.reset}`);
      } catch (e: any) {
        console.error(`${C.red}Restore failed:${C.reset} ${e?.message ?? e}`);
        process.exit(1);
      }
    });
}
