import { Option, type Command } from "commander";
import { C, fail, projectNameOf, run } from "./chat-cmd-request.ts";
import { ppmApiRequest, type PpmRequestOptions } from "../utils/settings-request.ts";
import { promptSecret } from "../utils/secret-prompt.ts";

/**
 * `ppm jira`: Jira configs, watchers and tracked tickets, through `/api/jira` on the running PPM —
 * so its watchers start and stop at once and every open Jira panel refreshes
 * (`jira:config_changed`, `jira:watchers_changed`). Only when no PPM holds the database do the
 * routes run here, after the direct-write notice.
 *
 * The API token is typed at a terminal (`--token-prompt`), never passed as an argument, and never
 * from an AI chat. A new site or email without a new token clears the saved one, in the route, for
 * every caller: a token is not sent to a site it was not entered for.
 */

const WHERE = "the Jira panel → Credentials";

interface JiraConfig { id: number; projectId: number; baseUrl: string; email: string; hasToken: boolean; tokenCleared?: boolean }

/** `/api/jira<sub>`, through the server or here. */
export function jiraRequest<T>(method: string, sub: string, body?: unknown, opts: PpmRequestOptions = {}): Promise<T> {
  return ppmApiRequest<T>(method, `/jira${sub}`, body, opts);
}

/** The database id of the project a command names (by name or path), which Jira's routes key on. */
async function projectIdOf(project: string): Promise<number> {
  const name = await projectNameOf(project);
  const rows = await jiraRequest<Array<{ id: number; name: string }>>("GET", "/config/projects");
  const row = rows.find((p) => p.name === name);
  return row ? row.id : fail(`Project "${name}" not found`);
}

export async function registerJiraCommands(program: Command): Promise<void> {
  const jira = program.command("jira").description("Jira watcher utilities");
  registerConfigCommands(jira);
  const { registerJiraWatcherCommands } = await import("./jira-watcher-cmd.ts");
  registerJiraWatcherCommands(jira);
}

function registerConfigCommands(jira: Command): void {
  const config = jira.command("config").description("Manage Jira configs");

  config
    .command("set <projectName>")
    .description("Set a project's Jira site and email; a new site or email without a new token clears the saved token")
    .requiredOption("--url <url>", "Jira base URL (https://...)")
    .requiredOption("--email <email>", "Jira account email")
    .option("--token-prompt", "Type the API token at the terminal (required for a new config)")
    .addOption(new Option("--token <token>", "Refused: the token is typed with --token-prompt").hideHelp())
    .action((projectName: string, opts: { url: string; email: string; tokenPrompt?: boolean; token?: string }) => run(async () => {
      if (opts.token !== undefined) fail("The API token is never passed as an argument (it lands in shell history). Use --token-prompt.");
      const projectId = await projectIdOf(projectName);
      const token = opts.tokenPrompt ? await promptSecret("Jira API token: ", "The Jira API token", WHERE) : undefined;
      if (opts.tokenPrompt && !token) fail("No token typed; nothing was changed.");
      const saved = await jiraRequest<JiraConfig>("PUT", `/config/${projectId}`, { baseUrl: opts.url, email: opts.email, ...(token ? { token } : {}) });
      console.log(`${C.green}✓${C.reset} Jira config saved for "${projectName}" (id: ${saved.id})`);
      if (saved.tokenCleared) {
        console.log(`${C.yellow}The site or email changed, so the saved API token was cleared. Enter the API token again:${C.reset}`);
        console.log(`  ppm jira config set ${projectName} --url ${opts.url} --email ${opts.email} --token-prompt`);
      } else if (!saved.hasToken) {
        console.log(`${C.yellow}No API token is saved; enter it with --token-prompt.${C.reset}`);
      }
    })());

  config
    .command("show <projectName>")
    .description("Show Jira config (token masked)")
    .action((projectName: string) => run(async () => {
      const projectId = await projectIdOf(projectName);
      const configs = await jiraRequest<JiraConfig[]>("GET", "/config");
      const cfg = configs.find((c) => c.projectId === projectId);
      if (!cfg) return void console.log(`${C.yellow}No Jira config for "${projectName}"${C.reset}`);
      console.log(`  ID:    ${cfg.id}`);
      console.log(`  URL:   ${cfg.baseUrl}`);
      console.log(`  Email: ${cfg.email}`);
      console.log(`  Token: ${cfg.hasToken ? "****" : "(none — enter the API token again with --token-prompt)"}`);
    })());

  config
    .command("remove <projectName>")
    .description("Remove Jira config (cascades watchers + results)")
    .action((projectName: string) => run(async () => {
      await jiraRequest("DELETE", `/config/${await projectIdOf(projectName)}`);
      console.log(`${C.green}✓${C.reset} Config removed for "${projectName}"`);
    })());

  config
    .command("test <projectName>")
    .description("Test Jira connection")
    .action((projectName: string) => run(async () => {
      await jiraRequest("POST", `/config/${await projectIdOf(projectName)}/test`, {}, { timeoutMs: 60_000 });
      console.log(`${C.green}✓${C.reset} Connection successful`);
    })());
}
