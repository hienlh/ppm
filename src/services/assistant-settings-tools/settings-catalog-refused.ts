import { configService } from "../config.service.ts";
import { getAssistantSettings } from "../assistant/assistant-settings.service.ts";
import { getPPMBotBot } from "../telegram-bots.ts";
import type { RefusedSetting, UncoveredCategory } from "./settings-catalog-types.ts";

/**
 * What the Assistant may name but never change. A secret is never read either: `settings_get`
 * answers only whether one is stored, and the agent is sent to the field in PPM with
 * `/?openSettings=<category>`. A secret typed into a chat would stay in its history, reach the AI
 * provider and, from a Telegram turn, go back out over Telegram.
 */

const SECRET = "It is a secret: the Assistant never reads or writes it. The user types it into PPM.";
const hasText = (v: unknown) => typeof v === "string" && v.length > 0;

export const REFUSED_SETTINGS: readonly RefusedSetting[] = [
  { key: "auth.password", category: "general", label: "General → PPM's password", reason: "Only the user sets PPM's password, in Settings → General." },
  { key: "auth.token", category: "general", label: "General → Access token", reason: SECRET, isSet: () => hasText(configService.get("auth").token) },
  { key: "port", category: "general", label: "General → Port", reason: "It takes effect only after a restart and can cut the address the user reaches PPM at. The user changes it in Settings or with `ppm config set port`." },
  { key: "host", category: "general", label: "General → Listen address", reason: "It decides who on the network can reach PPM and takes effect only after a restart. The user changes it." },
  { key: "telegram.bot_token", category: "notifications", label: "Notifications → Telegram bot token", reason: SECRET, isSet: () => hasText((configService.get("telegram") as { bot_token?: string } | undefined)?.bot_token) },
  { key: "ntfy.server", category: "notifications", label: "Notifications → ntfy server and topic", reason: "A new server drops the stored token, which only the user can type again: the user sets ntfy up in Settings → Notifications." },
  { key: "ntfy.token", category: "notifications", label: "Notifications → ntfy access token", reason: SECRET, isSet: () => hasText((configService.get("ntfy") as { token?: string } | undefined)?.token) },
  { key: "assistant.telegram.bot_token", category: "assistant", label: "PPM Assistant → Telegram bot token", reason: SECRET, isSet: () => hasText(getPPMBotBot().bot_token) },
  { key: "assistant.mcp_servers", category: "assistant", label: "PPM Assistant → MCP servers", reason: "Their commands, environment and headers can hold secrets and run programs: the user edits them in Settings → PPM Assistant." },
  { key: "assistant.settings_tools", category: "assistant", label: "PPM Assistant → Let the Assistant change settings", reason: "Only the user turns these tools on or off." },
  { key: "ai.providers.*.api_key", category: "ai-provider", label: "AI Provider → API key", reason: SECRET, isSet: () => Object.values(configService.get("ai").providers ?? {}).some((p) => hasText((p as { api_key?: string }).api_key)) },
  { key: "ai.providers.*.cli_command", category: "ai-provider", label: "AI Provider → Command line, base URL, API key variable", reason: "They decide which program runs and where requests go: the user changes them in Settings → AI Provider." },
  { key: "ai.mcp_servers", category: "ai-provider", label: "AI Provider → MCP servers for chats", reason: "An MCP server is a program every chat runs, with its own secrets: the user adds it in Settings." },
  { key: "tunnel.enabled", category: "remote-access", label: "Remote Access → Public link", reason: "Use the `public_link_set` tool, which asks every time.", useInstead: "public_link_set" },
  { key: "tunnel.named", category: "remote-access", label: "Remote Access → Own domain, Tailscale, review links", reason: "They need a Cloudflare or Tailscale sign-in only the user can do, in Settings → Remote Access." },
  { key: "tunnel.namedTunnelToken", category: "remote-access", label: "Remote Access → Named tunnel token", reason: SECRET, isSet: () => hasText((configService.get("tunnel") as { namedTunnelToken?: string } | undefined)?.namedTunnelToken) },
  { key: "share_host.token", category: "remote-access", label: "Remote Access → Review address token", reason: SECRET, isSet: () => hasText((configService.get("share_host") as { token?: string } | undefined)?.token) },
  { key: "vault", category: "vault", label: "Vault", reason: "The vault has its own tools and password cards (`vault_list`, `vault_read`, `vault_propose`); its tiers and passwords are the user's alone." },
  { key: "remembered_approvals", category: "approvals", label: "Approvals → Allow & remember", reason: "Which requests are approved without a card is the user's alone: rules are made by pressing on a card and removed in Settings → Approvals." },
  { key: "accounts.sign_in", category: "accounts", label: "Accounts → Sign in, add, remove, export, import", reason: "Signing in needs the user, and an export holds the accounts' tokens." },
];

/** Whether `key` is a refused one (a `*` stands for one segment). */
export function refusedSetting(key: string): RefusedSetting | null {
  const parts = key.split(".");
  return REFUSED_SETTINGS.find((r) => {
    const p = r.key.split(".");
    return p.length === parts.length && p.every((s, i) => s === "*" || s === parts[i]);
  }) ?? REFUSED_SETTINGS.find((r) => key === r.key || key.startsWith(`${r.key}.`)) ?? null;
}

/** Whether the Assistant's own switch for these tools is on: off until the user chooses. */
export function settingsToolsOn(): boolean {
  return getAssistantSettings().settings_tools === true;
}

/**
 * The Settings categories with nothing the Assistant changes, and why. Together with the catalog
 * this covers every category in the rail (`settings-catalog-coverage.test.ts`).
 */
export const UNCOVERED_CATEGORIES: readonly UncoveredCategory[] = [
  { category: "language-servers", reason: "Install or remove a server with `settings_install`; whether the editor uses them is kept per browser." },
  { category: "remote-desktop", reason: "Install or remove the WebRTC relay with `settings_install`; the viewer's options are kept per browser." },
  { category: "database-drivers", reason: "Install or remove a driver with `settings_install`." },
  { category: "vault", reason: "The vault has its own tools and password cards." },
  { category: "jira", reason: "Jira watchers are set up per project in Settings → Jira Watcher; `jira_config_get` reads them." },
  { category: "extensions", reason: "Installing an extension runs its code: the user does it in Settings → Extensions." },
  { category: "proxy", reason: "The API proxy hands out the user's accounts: the user switches it in Settings → API Proxy." },
  { category: "remote-access", reason: "Use `public_link_set` and `port_forward_*`; the rest needs a sign-in only the user can do." },
  { category: "schedules", reason: "Use the schedule tools (`schedules_list`, `schedule_save`, …)." },
  { category: "shortcuts", reason: "Key bindings are edited in Settings → Keyboard Shortcuts." },
];
