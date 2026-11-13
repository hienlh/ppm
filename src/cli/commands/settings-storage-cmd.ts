import type { Command } from "commander";
import { C, fail, run } from "./chat-cmd-request.ts";
import { settingsRequest } from "../utils/settings-request.ts";
import { refuseInAiChat } from "../utils/ai-chat-refusal.ts";

/**
 * `ppm settings files|query-audit|trace` — the global file filters and how long PPM keeps its
 * own logs, through the routes Settings → Files and Settings → Storage call.
 *
 * From an AI chat (advisory, see `ai-chat-refusal.ts`), the audit log is not cleared and the
 * session trace limits are not changed: both are the record of what an AI did.
 */

type FileFilters = { filesExclude: string[]; searchExclude: string[]; useIgnoreFiles: boolean };
type AuditSettings = { retention_days: number; max_size_mb: number; size_bytes: number; entry_count: number };
type TraceStorage = { retention_days?: number; max_size_mb?: number; sizeBytes?: number };

const whole = (raw: string, name: string): number => {
  const n = Number(raw);
  if (!Number.isInteger(n)) fail(`${name} takes a whole number, got "${raw}"`);
  return n;
};
const mb = (bytes: number | undefined) => `${((bytes ?? 0) / 1024 / 1024).toFixed(1)} MB`;

/** Limits from `--retention-days` / `--max-size-mb`; at least one is required. */
function limits(opts: { retentionDays?: string; maxSizeMb?: string }): Record<string, number> {
  const body: Record<string, number> = {};
  if (opts.retentionDays !== undefined) body.retention_days = whole(opts.retentionDays, "--retention-days");
  if (opts.maxSizeMb !== undefined) body.max_size_mb = whole(opts.maxSizeMb, "--max-size-mb");
  if (Object.keys(body).length === 0) fail("Give --retention-days and/or --max-size-mb");
  return body;
}

export function registerSettingsCommands(program: Command): void {
  const settings = program.command("settings").description("PPM's file filters and how long it keeps its logs");

  const files = settings.command("files").description("The file filters every project uses unless it sets its own");
  files
    .command("get")
    .description("Show the global file filters")
    .option("--json", "Print JSON")
    .action((opts: { json?: boolean }) => run(async () => {
      const f = await settingsRequest<FileFilters>("GET", "/files");
      if (opts.json) return void console.log(JSON.stringify(f, null, 2));
      console.log(`Hidden from the file tree: ${f.filesExclude.join(", ") || "(none)"}`);
      console.log(`Left out of search:        ${f.searchExclude.join(", ") || "(none)"}`);
      console.log(`Honour .gitignore:         ${f.useIgnoreFiles ? "yes" : "no"}`);
    })());
  files
    .command("set")
    .description("Replace the global file filters; a list option replaces that whole list (\"\" empties it)")
    .option("--exclude <globs...>", "Globs hidden from the file tree")
    .option("--search-exclude <globs...>", "Globs left out of search")
    .option("--use-ignore-files <bool>", "Honour .gitignore: true or false")
    .action((opts: { exclude?: string[]; searchExclude?: string[]; useIgnoreFiles?: string }) => run(async () => {
      const list = (v: string[]) => v.filter((g) => g.trim() !== "");
      const body: Partial<FileFilters> = {};
      if (opts.exclude) body.filesExclude = list(opts.exclude);
      if (opts.searchExclude) body.searchExclude = list(opts.searchExclude);
      if (opts.useIgnoreFiles !== undefined) {
        if (opts.useIgnoreFiles !== "true" && opts.useIgnoreFiles !== "false") fail("--use-ignore-files takes true or false");
        body.useIgnoreFiles = opts.useIgnoreFiles === "true";
      }
      if (Object.keys(body).length === 0) fail("Give --exclude, --search-exclude and/or --use-ignore-files");
      await settingsRequest("PATCH", "/files", body);
      console.log(`${C.green}Updated:${C.reset} the global file filters`);
    })());

  const audit = settings.command("query-audit").description("The log of every database statement PPM ran");
  audit
    .command("get")
    .description("Show how long the log is kept and what it holds")
    .option("--json", "Print JSON")
    .action((opts: { json?: boolean }) => run(async () => {
      const a = await settingsRequest<AuditSettings>("GET", "/query-audit");
      if (opts.json) return void console.log(JSON.stringify(a, null, 2));
      console.log(`Kept for ${a.retention_days} days, at most ${a.max_size_mb} MB; now ${a.entry_count} statements, ${mb(a.size_bytes)}`);
    })());
  audit
    .command("set")
    .description("Change how long the log is kept")
    .option("--retention-days <n>", "Days to keep a statement (at least 1)")
    .option("--max-size-mb <n>", "Size the log is cut back to (at least 10)")
    .action((opts: { retentionDays?: string; maxSizeMb?: string }) => run(async () => {
      const a = await settingsRequest<AuditSettings>("PUT", "/query-audit", limits(opts));
      console.log(`${C.green}Updated:${C.reset} kept for ${a.retention_days} days, at most ${a.max_size_mb} MB`);
    })());
  audit
    .command("clear")
    .description("Delete every recorded statement (cannot be undone)")
    .option("--yes", "Confirm the deletion")
    .action((opts: { yes?: boolean }) => run(async () => {
      refuseInAiChat("Clearing the query audit log", "Settings → Storage");
      if (!opts.yes) fail("This deletes every recorded statement. Run it again with --yes to go ahead.");
      const r = await settingsRequest<{ deleted: number }>("DELETE", "/query-audit/logs");
      console.log(`${C.green}Cleared:${C.reset} ${r.deleted} statements`);
    })());

  const trace = settings.command("trace").description("The session trace: what every chat turn did");
  trace
    .command("set")
    .description("Change how long the session trace is kept")
    .option("--retention-days <n>", "Days to keep a session's trace")
    .option("--max-size-mb <n>", "Size the trace is cut back to")
    .action((opts: { retentionDays?: string; maxSizeMb?: string }) => run(async () => {
      refuseInAiChat("The session trace limits", "Settings → Storage");
      const t = await settingsRequest<TraceStorage>("PUT", "/session-trace", limits(opts));
      console.log(`${C.green}Updated:${C.reset} kept for ${t.retention_days} days, at most ${t.max_size_mb} MB (now ${mb(t.sizeBytes)})`);
    })());
}
