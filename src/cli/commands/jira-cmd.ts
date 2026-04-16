import { Command } from "commander";

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", green: "\x1b[32m",
  red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", dim: "\x1b[2m",
};

export async function registerJiraCommands(program: Command): Promise<void> {
  const jira = program.command("jira").description("Jira watcher utilities");
  registerConfigCommands(jira);
  await registerWatcherCommands(jira);
}

// ── Config commands ───────────────────────────────────────────────────

function registerConfigCommands(jira: Command): void {
  const config = jira.command("config").description("Manage Jira configs");

  config
    .command("set <projectName>")
    .description("Set Jira config for a project")
    .requiredOption("--url <url>", "Jira base URL (https://...)")
    .requiredOption("--email <email>", "Jira account email")
    .requiredOption("--token <token>", "API token (⚠ visible in shell history)")
    .action(async (projectName: string, opts: { url: string; email: string; token: string }) => {
      try {
        const { getDb } = await import("../../services/db.service.ts");
        const project = getDb().query("SELECT id FROM projects WHERE name = ?").get(projectName) as { id: number } | null;
        if (!project) { console.error(`${C.red}✗${C.reset} Project "${projectName}" not found`); process.exit(1); }
        const { upsertConfig } = await import("../../services/jira-config.service.ts");
        const cfg = upsertConfig(project.id, opts.url, opts.email, opts.token);
        console.log(`${C.green}✓${C.reset} Jira config saved for "${projectName}" (id: ${cfg.id})`);
      } catch (e: any) { console.error(`${C.red}✗${C.reset} ${e.message}`); process.exit(1); }
    });

  config
    .command("show <projectName>")
    .description("Show Jira config (token masked)")
    .action(async (projectName: string) => {
      try {
        const { getDb } = await import("../../services/db.service.ts");
        const project = getDb().query("SELECT id FROM projects WHERE name = ?").get(projectName) as { id: number } | null;
        if (!project) { console.error(`${C.red}✗${C.reset} Project not found`); process.exit(1); }
        const { getConfigByProjectId } = await import("../../services/jira-config.service.ts");
        const cfg = getConfigByProjectId(project.id);
        if (!cfg) { console.log(`${C.yellow}No Jira config for "${projectName}"${C.reset}`); return; }
        console.log(`  URL:   ${cfg.baseUrl}`);
        console.log(`  Email: ${cfg.email}`);
        console.log(`  Token: ${cfg.hasToken ? "****" : "(none)"}`);
      } catch (e: any) { console.error(`${C.red}✗${C.reset} ${e.message}`); process.exit(1); }
    });

  config
    .command("remove <projectName>")
    .description("Remove Jira config (cascades watchers + results)")
    .action(async (projectName: string) => {
      try {
        const { getDb } = await import("../../services/db.service.ts");
        const project = getDb().query("SELECT id FROM projects WHERE name = ?").get(projectName) as { id: number } | null;
        if (!project) { console.error(`${C.red}✗${C.reset} Project not found`); process.exit(1); }
        const { deleteConfig } = await import("../../services/jira-config.service.ts");
        deleteConfig(project.id);
        console.log(`${C.green}✓${C.reset} Config removed for "${projectName}"`);
      } catch (e: any) { console.error(`${C.red}✗${C.reset} ${e.message}`); process.exit(1); }
    });

  config
    .command("test <projectName>")
    .description("Test Jira connection")
    .action(async (projectName: string) => {
      try {
        const { getDb } = await import("../../services/db.service.ts");
        const project = getDb().query("SELECT id FROM projects WHERE name = ?").get(projectName) as { id: number } | null;
        if (!project) { console.error(`${C.red}✗${C.reset} Project not found`); process.exit(1); }
        const { getConfigByProjectId, getDecryptedCredentials } = await import("../../services/jira-config.service.ts");
        const cfg = getConfigByProjectId(project.id);
        if (!cfg) { console.error(`${C.red}✗${C.reset} No config found`); process.exit(1); }
        const creds = getDecryptedCredentials(cfg.id);
        if (!creds) { console.error(`${C.red}✗${C.reset} Failed to decrypt token`); process.exit(1); }
        const { testConnection } = await import("../../services/jira-api-client.ts");
        await testConnection(creds);
        console.log(`${C.green}✓${C.reset} Connection successful`);
      } catch (e: any) { console.error(`${C.red}✗${C.reset} ${e.message}`); process.exit(1); }
    });
}

// ── Watcher + result + ticket commands ────────────────────────────────

async function registerWatcherCommands(jira: Command): Promise<void> {
  const { registerJiraWatcherCommands } = await import("./jira-watcher-cmd.ts");
  registerJiraWatcherCommands(jira);
}
