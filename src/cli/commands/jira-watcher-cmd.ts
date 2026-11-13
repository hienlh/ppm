import type { Command } from "commander";
import { C, run } from "./chat-cmd-request.ts";
import { jiraRequest } from "./jira-cmd.ts";

/**
 * `ppm jira watch`, `ppm jira results` and `ppm jira track`, through the watcher routes the Jira
 * panel calls: a watcher added or switched here starts or stops polling in the running PPM, and
 * every open Jira panel shows it (`jira:watchers_changed`).
 *
 * A pull runs only inside the running PPM: a watcher in debug mode starts a debug chat for each
 * new ticket, which must live in PPM, not in this command's process.
 */

interface Watcher { id: number; jiraConfigId: number; name: string; jql: string; mode: string; intervalMs: number; enabled: boolean }
interface Result { id: number; issueKey: string; status: string; issueSummary: string | null; source: string }
interface Issue { key: string; fields: { summary: string } }

const PULL_SERVER_ONLY = "A pull runs inside the running PPM (it may start a debug chat for each new ticket).";

const brief = (w: Watcher) => ({ id: w.id, config: w.jiraConfigId, name: w.name, jql: w.jql, mode: w.mode, intervalMs: w.intervalMs, enabled: w.enabled });

export function registerJiraWatcherCommands(jira: Command): void {
  const watch = jira.command("watch").description("Manage Jira watchers");

  watch.command("add")
    .description("Create a new watcher")
    .requiredOption("--config <id>", "Jira config ID")
    .requiredOption("--name <name>", "Watcher name")
    .requiredOption("--jql <jql>", "JQL filter query")
    .option("--interval <ms>", "Poll interval in ms", "120000")
    .option("--prompt <template>", "Custom prompt template")
    .option("--mode <mode>", "debug or notify", "debug")
    .action((opts: { config: string; name: string; jql: string; interval: string; prompt?: string; mode: string }) => run(async () => {
      const w = await jiraRequest<Watcher>("POST", "/watchers", {
        configId: Number(opts.config), name: opts.name, jql: opts.jql,
        intervalMs: Number(opts.interval), promptTemplate: opts.prompt, mode: opts.mode,
      });
      console.log(`${C.green}✓${C.reset} Watcher created (id: ${w.id})`);
    })());

  watch.command("list")
    .description("List watchers")
    .option("--config <id>", "Filter by config ID")
    .option("--json", "Print JSON")
    .action((opts: { config?: string; json?: boolean }) => run(async () => {
      const configIds = opts.config
        ? [Number(opts.config)]
        : (await jiraRequest<Array<{ id: number }>>("GET", "/config")).map((c) => c.id);
      const list: Watcher[] = [];
      for (const id of configIds) list.push(...await jiraRequest<Watcher[]>("GET", `/watchers?configId=${id}`));
      if (opts.json) return void console.log(JSON.stringify(list, null, 2));
      if (!list.length) return void console.log("No watchers found.");
      console.table(list.map(brief));
    })());

  for (const [verb, enabled] of [["enable", true], ["disable", false]] as const) {
    watch.command(`${verb} <id>`).description(`${enabled ? "Enable" : "Disable"} watcher`).action((id: string) => run(async () => {
      await jiraRequest("PUT", `/watchers/${Number(id)}`, { enabled });
      console.log(`${C.green}✓${C.reset} Watcher ${id} ${enabled ? "enabled" : "disabled"}`);
    })());
  }

  watch.command("remove <id>").description("Delete watcher").action((id: string) => run(async () => {
    await jiraRequest("DELETE", `/watchers/${Number(id)}`);
    console.log(`${C.green}✓${C.reset} Watcher ${id} deleted`);
  })());

  watch.command("test <id>").description("Dry-run poll (show matches without creating tasks)")
    .action((id: string) => run(async () => {
      const w = await jiraRequest<Watcher>("GET", `/watchers/${Number(id)}`);
      const res = await jiraRequest<{ issues: Issue[]; total: number }>("POST", "/watchers/test-jql", { configId: w.jiraConfigId, jql: w.jql }, { timeoutMs: 60_000 });
      console.log(`Found ${res.total} issues (showing ${res.issues.length}):`);
      for (const i of res.issues) console.log(`  ${C.cyan}${i.key}${C.reset} ${i.fields.summary}`);
    })());

  watch.command("pull [id]").description("Manual pull (one watcher or all enabled)")
    .action((id?: string) => run(async () => {
      const opts = { timeoutMs: 300_000, serverOnly: PULL_SERVER_ONLY };
      const res = id
        ? await jiraRequest<{ newIssues: number }>("POST", `/watchers/${Number(id)}/pull`, {}, opts)
        : await jiraRequest<{ newIssues: number }>("POST", "/watchers/pull-all", {}, opts);
      console.log(`${C.green}✓${C.reset} Pulled ${res.newIssues} new issue(s)${id ? "" : " total"}`);
    })());

  // ── Results ───────────────────────────────────────────────────────

  const results = jira.command("results").description("View Jira watch results");
  results
    .option("--watcher <id>", "Filter by watcher ID")
    .option("--status <status>", "Filter by status")
    .action((opts: { watcher?: string; status?: string }) => run(async () => {
      const query = new URLSearchParams();
      if (opts.watcher) query.set("watcherId", String(Number(opts.watcher)));
      if (opts.status) query.set("status", opts.status);
      const search = query.toString();
      const list = await jiraRequest<Result[]>("GET", `/results${search ? `?${search}` : ""}`);
      if (!list.length) return void console.log("No results.");
      console.table(list.map((r) => ({
        id: r.id, key: r.issueKey, status: r.status, summary: (r.issueSummary ?? "").slice(0, 50), source: r.source,
      })));
    })());

  results.command("delete <id>").description("Soft-delete result").action((id: string) => run(async () => {
    await jiraRequest("DELETE", `/results/${Number(id)}`);
    console.log(`${C.green}✓${C.reset} Result ${id} deleted`);
  })());

  // ── Ticket ────────────────────────────────────────────────────────

  jira.command("track <issueKey>")
    .description("Manually track a Jira issue")
    .requiredOption("--config <id>", "Jira config ID")
    .action((issueKey: string, opts: { config: string }) => run(async () => {
      try {
        const res = await jiraRequest<{ issueKey: string }>("POST", "/results/manual", { configId: Number(opts.config), issueKey }, { timeoutMs: 60_000 });
        console.log(`${C.green}✓${C.reset} Tracking ${res.issueKey}`);
      } catch (e) {
        if (/already tracked/i.test((e as Error).message)) return void console.log(`${C.yellow}Already tracked${C.reset}`);
        throw e;
      }
    })());
}
