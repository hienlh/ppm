import type { Command } from "commander";

const C = {
  reset: "\x1b[0m", green: "\x1b[32m", red: "\x1b[31m",
  yellow: "\x1b[33m", cyan: "\x1b[36m", dim: "\x1b[2m",
};

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
    .action(async (opts) => {
      try {
        const { createWatcher } = await import("../../services/jira-watcher-db.service.ts");
        const w = createWatcher(Number(opts.config), opts.name, opts.jql, {
          intervalMs: Number(opts.interval), promptTemplate: opts.prompt, mode: opts.mode,
        });
        console.log(`${C.green}✓${C.reset} Watcher created (id: ${w.id})`);
      } catch (e: any) { console.error(`${C.red}✗${C.reset} ${e.message}`); process.exit(1); }
    });

  watch.command("list")
    .description("List watchers")
    .option("--config <id>", "Filter by config ID")
    .action(async (opts) => {
      try {
        const { getWatchersByConfigId } = await import("../../services/jira-watcher-db.service.ts");
        const { getAllEnabledWatchers } = await import("../../services/jira-watcher-db.service.ts");
        const list = opts.config
          ? getWatchersByConfigId(Number(opts.config))
          : getAllEnabledWatchers().map((w) => ({ id: w.id, name: w.name, jql: w.jql, mode: w.mode, intervalMs: w.interval_ms, enabled: w.enabled === 1 }));
        if (!list.length) { console.log("No watchers found."); return; }
        console.table(list);
      } catch (e: any) { console.error(`${C.red}✗${C.reset} ${e.message}`); process.exit(1); }
    });

  watch.command("enable <id>").description("Enable watcher").action(async (id) => {
    try {
      const { updateWatcher } = await import("../../services/jira-watcher-db.service.ts");
      updateWatcher(Number(id), { enabled: true });
      console.log(`${C.green}✓${C.reset} Watcher ${id} enabled`);
    } catch (e: any) { console.error(`${C.red}✗${C.reset} ${e.message}`); process.exit(1); }
  });

  watch.command("disable <id>").description("Disable watcher").action(async (id) => {
    try {
      const { updateWatcher } = await import("../../services/jira-watcher-db.service.ts");
      updateWatcher(Number(id), { enabled: false });
      console.log(`${C.green}✓${C.reset} Watcher ${id} disabled`);
    } catch (e: any) { console.error(`${C.red}✗${C.reset} ${e.message}`); process.exit(1); }
  });

  watch.command("remove <id>").description("Delete watcher").action(async (id) => {
    try {
      const { deleteWatcher } = await import("../../services/jira-watcher-db.service.ts");
      deleteWatcher(Number(id));
      console.log(`${C.green}✓${C.reset} Watcher ${id} deleted`);
    } catch (e: any) { console.error(`${C.red}✗${C.reset} ${e.message}`); process.exit(1); }
  });

  watch.command("test <id>").description("Dry-run poll (show matches without creating tasks)")
    .action(async (id) => {
      try {
        const { getDb } = await import("../../services/db.service.ts");
        const w = getDb().query("SELECT * FROM jira_watchers WHERE id = ?").get(Number(id)) as any;
        if (!w) { console.error(`${C.red}✗${C.reset} Watcher not found`); process.exit(1); }
        const { getDecryptedCredentials } = await import("../../services/jira-config.service.ts");
        const creds = getDecryptedCredentials(w.jira_config_id);
        if (!creds) { console.error(`${C.red}✗${C.reset} No credentials`); process.exit(1); }
        const { searchIssues } = await import("../../services/jira-api-client.ts");
        const res = await searchIssues(creds, w.jql);
        console.log(`Found ${res.total} issues (showing ${res.issues.length}):`);
        for (const i of res.issues) console.log(`  ${C.cyan}${i.key}${C.reset} ${i.fields.summary}`);
      } catch (e: any) { console.error(`${C.red}✗${C.reset} ${e.message}`); process.exit(1); }
    });

  watch.command("pull [id]").description("Manual pull (one watcher or all enabled)")
    .action(async (id?: string) => {
      try {
        const { jiraWatcherService } = await import("../../services/jira-watcher.service.ts");
        if (id) {
          const count = await jiraWatcherService.pollWatcher(Number(id));
          console.log(`${C.green}✓${C.reset} Pulled ${count} new issue(s)`);
        } else {
          const { getAllEnabledWatchers } = await import("../../services/jira-watcher-db.service.ts");
          let total = 0;
          for (const w of getAllEnabledWatchers()) {
            try { total += await jiraWatcherService.pollWatcher(w.id); } catch {}
          }
          console.log(`${C.green}✓${C.reset} Pulled ${total} new issue(s) total`);
        }
      } catch (e: any) { console.error(`${C.red}✗${C.reset} ${e.message}`); process.exit(1); }
    });

  // ── Results ───────────────────────────────────────────────────────

  const results = jira.command("results").description("View Jira watch results");
  results
    .option("--watcher <id>", "Filter by watcher ID")
    .option("--status <status>", "Filter by status")
    .action(async (opts) => {
      try {
        const { getResultsByWatcherId } = await import("../../services/jira-watcher-db.service.ts");
        const list = getResultsByWatcherId(
          opts.watcher ? Number(opts.watcher) : undefined,
          { status: opts.status },
        );
        if (!list.length) { console.log("No results."); return; }
        console.table(list.map((r) => ({
          id: r.id, key: r.issueKey, status: r.status,
          summary: (r.issueSummary ?? "").slice(0, 50), source: r.source,
        })));
      } catch (e: any) { console.error(`${C.red}✗${C.reset} ${e.message}`); process.exit(1); }
    });

  results.command("delete <id>").description("Soft-delete result").action(async (id) => {
    try {
      const { softDeleteResult } = await import("../../services/jira-watcher-db.service.ts");
      softDeleteResult(Number(id));
      console.log(`${C.green}✓${C.reset} Result ${id} deleted`);
    } catch (e: any) { console.error(`${C.red}✗${C.reset} ${e.message}`); process.exit(1); }
  });

  // ── Ticket ────────────────────────────────────────────────────────

  jira.command("track <issueKey>")
    .description("Manually track a Jira issue")
    .requiredOption("--config <id>", "Jira config ID")
    .action(async (issueKey, opts) => {
      try {
        const { getDecryptedCredentials } = await import("../../services/jira-config.service.ts");
        const creds = getDecryptedCredentials(Number(opts.config));
        if (!creds) { console.error(`${C.red}✗${C.reset} Invalid config`); process.exit(1); }
        const { getIssue } = await import("../../services/jira-api-client.ts");
        const issue = await getIssue(creds, issueKey);
        const { insertResult } = await import("../../services/jira-watcher-db.service.ts");
        const { inserted } = insertResult(null, issue.key, issue.fields.summary, issue.fields.updated, "manual");
        if (!inserted) { console.log(`${C.yellow}Already tracked${C.reset}`); return; }
        console.log(`${C.green}✓${C.reset} Tracking ${issue.key}: ${issue.fields.summary}`);
      } catch (e: any) { console.error(`${C.red}✗${C.reset} ${e.message}`); process.exit(1); }
    });
}
