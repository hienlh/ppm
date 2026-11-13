import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { C, fail, run } from "./chat-cmd-request.ts";
import { settingsRequest } from "../utils/settings-request.ts";
import { refuseInAiChat } from "../utils/ai-chat-refusal.ts";
import { promptSecret } from "../utils/secret-prompt.ts";
import {
  buildMcpConfig, describeMcpServer, isMcpSecretName, redactMcpConfig, type McpEditOptions,
} from "../utils/mcp-server-config-edit.ts";
import type { McpServerConfig } from "../../types/mcp.ts";

/**
 * `ppm mcp`: the MCP servers every chat starts with (Settings → MCP, the AI Resources panel),
 * through `/api/settings/mcp`, so every open PPM's list updates.
 *
 * An env or header value is typed at the terminal (`--env NAME`, `--header NAME`), never passed as
 * an argument, and never printed: the list shows names only. From an AI chat (advisory, see
 * `ai-chat-refusal.ts`) no server's command, arguments or address is set and nothing is imported —
 * each runs at the start of every later chat. Signing in to a server is the user's (`mcp-auth`).
 */

const WHERE = "Settings → MCP";
const collect = (value: string, all: string[]) => [...all, value];

interface Entry { name: string; transport: string; config: McpServerConfig }

const mcp = <T>(method: string, sub: string, body?: unknown) => settingsRequest<T>(method, `/mcp${sub}`, body);

/** The values for `--env`/`--header` names, typed at the terminal one by one. */
async function typedValues(names: string[], kind: string, server: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const name of names) {
    if (!isMcpSecretName(name)) fail(`"${name}" is not a ${kind} name; give the name only — its value is asked for`);
    values[name] = await promptSecret(`${kind} ${name} for ${server}: `, `An MCP server's ${kind} value`, WHERE);
  }
  return values;
}

function withEditOptions(cmd: Command): Command {
  return cmd
    .option("--command <cmd>", "A local server: the program to run")
    .option("--arg <value>", "An argument for --command (repeat for each)", collect, [])
    .option("--url <url>", "A remote server's address")
    .option("--type <type>", "http or sse, for --url (default http)")
    .option("--env <name>", "Set an environment variable; its value is typed at the terminal (repeat)", collect, [])
    .option("--header <name>", "Set a header; its value is typed at the terminal (repeat)", collect, []);
}

type CmdOpts = { command?: string; arg: string[]; url?: string; type?: string; env: string[]; header: string[]; unsetEnv?: string[]; unsetHeader?: string[] };

/** Refuses, from an AI chat, anything that decides what a server runs or where it connects. */
function refuseRunChange(opts: CmdOpts): void {
  if (opts.command || opts.url || opts.arg.length || opts.type) refuseInAiChat("An MCP server's command, arguments or address", WHERE);
}

async function editOptions(opts: CmdOpts, name: string): Promise<McpEditOptions> {
  return {
    command: opts.command, arg: opts.arg, url: opts.url, type: opts.type,
    env: await typedValues(opts.env, "env", name), header: await typedValues(opts.header, "header", name),
    unsetEnv: opts.unsetEnv, unsetHeader: opts.unsetHeader,
  };
}

export function registerMcpCommands(program: Command): void {
  const cmd = program.command("mcp").description("The MCP servers every chat starts with");

  cmd
    .command("list")
    .description("List the servers; env and header values are never shown")
    .option("--json", "Print JSON (values redacted)")
    .action((opts: { json?: boolean }) => run(async () => {
      const servers = await mcp<Entry[]>("GET", "");
      if (opts.json) return void console.log(JSON.stringify(servers.map((s) => ({ ...s, config: redactMcpConfig(s.config) })), null, 2));
      if (servers.length === 0) console.log(`${C.dim}No MCP servers.${C.reset}`);
      for (const s of servers) console.log(describeMcpServer(s.name, s.config));
    })());

  withEditOptions(cmd.command("add <name>").description("Add a server: --command (with --arg) or --url"))
    .action((name: string, opts: CmdOpts) => run(async () => {
      refuseRunChange(opts);
      const config = buildMcpConfig(null, await editOptions(opts, name));
      if ("error" in config) fail(config.error);
      await mcp("POST", "", { name, config });
      console.log(`${C.green}Added:${C.reset} ${describeMcpServer(name, config)}`);
    })());

  withEditOptions(cmd.command("edit <name>").description("Change a server; what is not given is kept"))
    .option("--unset-env <name>", "Remove an environment variable (repeat)", collect, [])
    .option("--unset-header <name>", "Remove a header (repeat)", collect, [])
    .action((name: string, opts: CmdOpts) => run(async () => {
      refuseRunChange(opts);
      // Values are typed first, so a command with no terminal stops before any request.
      const edits = await editOptions(opts, name);
      const config = buildMcpConfig(await mcp<McpServerConfig>("GET", `/${encodeURIComponent(name)}`), edits);
      if ("error" in config) fail(config.error);
      await mcp("PUT", `/${encodeURIComponent(name)}`, config);
      console.log(`${C.green}Saved:${C.reset} ${describeMcpServer(name, config)}`);
    })());

  cmd
    .command("remove <name>")
    .description("Remove a server; chats started after this do not get it")
    .action((name: string) => run(async () => {
      await mcp("DELETE", `/${encodeURIComponent(name)}`);
      console.log(`${C.green}Removed:${C.reset} ${name}`);
    })());

  cmd
    .command("import [file]")
    .description("Add the servers from ~/.claude.json, or from a JSON file (`{ mcpServers: {...} }`); existing names are kept")
    .action((file: string | undefined) => run(async () => {
      refuseInAiChat("Importing MCP servers", WHERE);
      if (!file) {
        const r = await mcp<{ imported: number; skipped: number }>("POST", "/import", {});
        return void console.log(`${C.green}Imported ${r.imported}${C.reset}, skipped ${r.skipped} (from ~/.claude.json)`);
      }
      const servers = readServersFile(file);
      const existing = new Set((await mcp<Entry[]>("GET", "")).map((s) => s.name));
      let imported = 0;
      for (const [name, config] of Object.entries(servers)) {
        if (existing.has(name)) { console.log(`${C.dim}Kept the existing ${name}${C.reset}`); continue; }
        await mcp("POST", "", { name, config });
        imported++;
      }
      console.log(`${C.green}Imported ${imported}${C.reset} of ${Object.keys(servers).length}`);
    })());
}

function readServersFile(file: string): Record<string, McpServerConfig> {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch (e) { return fail(`Cannot read ${file}: ${(e as Error).message}`); }
  const root = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const servers = (root.mcpServers && typeof root.mcpServers === "object" ? root.mcpServers : root) as Record<string, McpServerConfig>;
  if (Object.keys(servers).length === 0) fail(`${file} names no MCP servers`);
  return servers;
}
