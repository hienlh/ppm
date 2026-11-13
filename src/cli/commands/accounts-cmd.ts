import type { Command } from "commander";
import { C, fail, run } from "./chat-cmd-request.ts";
import { ppmApiRequest } from "../utils/settings-request.ts";
import { accountRow, findAccount, type AccountRow, type ClaudeAccount, type CodexAccount, type Provider } from "../utils/account-rows.ts";

/**
 * `ppm accounts`: the Claude and Codex accounts chats rotate across (Settings → Accounts), through
 * `/api/accounts` and `/api/codex-accounts`, so every open PPM's account list updates.
 *
 * Nothing here takes or prints a token: the list carries no credential, and signing in — an OAuth
 * login, a device code, an API key — stays in Settings → Accounts, where it is typed or approved.
 */

const PROVIDERS = ["claude", "codex"] as const;
const CLAUDE_STRATEGIES = ["round-robin", "fill-first", "lowest-usage"];

async function listAccounts(provider?: Provider): Promise<AccountRow[]> {
  const rows: AccountRow[] = [];
  if (provider !== "codex") rows.push(...(await ppmApiRequest<ClaudeAccount[]>("GET", "/accounts")).map((a) => accountRow("claude", a)));
  if (provider !== "claude") rows.push(...(await ppmApiRequest<{ accounts: CodexAccount[] }>("GET", "/codex-accounts")).accounts.map((a) => accountRow("codex", a)));
  return rows;
}

function providerOption(value: string | undefined): Provider | undefined {
  if (value !== undefined && !(PROVIDERS as readonly string[]).includes(value)) fail("--provider is claude or codex");
  return value as Provider | undefined;
}

const base = (p: Provider) => (p === "claude" ? "/accounts" : "/codex-accounts");

export function registerAccountsCommands(program: Command): void {
  const acc = program.command("accounts").description("The Claude and Codex accounts chats rotate across");

  acc
    .command("list")
    .description("List the accounts (no credential is ever shown)")
    .option("--provider <provider>", "claude or codex")
    .option("--json", "Print JSON")
    .action((opts: { provider?: string; json?: boolean }) => run(async () => {
      const rows = await listAccounts(providerOption(opts.provider));
      if (opts.json) return void console.log(JSON.stringify(rows, null, 2));
      if (rows.length === 0) console.log(`${C.dim}No accounts. Sign in from PPM → Settings → Accounts.${C.reset}`);
      for (const r of rows) console.log(`${r.id}  ${r.provider.padEnd(6)} ${r.status.padEnd(8)} ${r.label ?? ""}${r.email ? ` <${r.email}>` : ""}${r.note ? `  ${C.yellow}${r.note}${C.reset}` : ""}`);
    })());

  acc
    .command("add")
    .description("How to add an account")
    .action(() => console.log("Sign in from PPM → Settings → Accounts: a login or an API key is typed or approved there, never on a command line."));

  acc
    .command("pick")
    .description("Claim the account the next new chat runs on (moves the rotation on)")
    .option("--provider <provider>", "claude or codex", "claude")
    .action((opts: { provider: string }) => run(async () => {
      const p = providerOption(opts.provider)!;
      const picked = await ppmApiRequest<{ id: string; label: string | null } | null | "timeout">("POST", `${base(p)}/pick`, {});
      if (picked && typeof picked === "object") console.log(`${picked.id}  ${picked.label ?? ""}`);
      else console.log(`${C.dim}${picked === "timeout" ? "The usage check timed out; no account was picked." : `No ${p} account can serve a chat right now.`}${C.reset}`);
    })());

  acc
    .command("verify <id>")
    .description("Check a Claude account's sign-in again and refresh its profile")
    .action((id: string) => run(async () => {
      const a = findAccount(await listAccounts(), id);
      if (a.provider !== "claude") fail("Only a Claude account is checked this way; a Codex account is checked on its next turn");
      const r = await ppmApiRequest<{ valid: boolean; email?: string | null }>("POST", `/accounts/${encodeURIComponent(a.id)}/verify`, {});
      console.log(r.valid ? `${C.green}Valid${C.reset}${r.email ? ` (${r.email})` : ""}` : `${C.red}Not valid${C.reset}: sign in again in Settings → Accounts`);
    })());

  acc
    .command("rename <id> <label>")
    .description("Rename a Claude account")
    .action((id: string, label: string) => run(async () => {
      const a = findAccount(await listAccounts(), id);
      if (a.provider !== "claude") fail("A Codex account is renamed in Settings → Accounts");
      await ppmApiRequest("PATCH", `/accounts/${encodeURIComponent(a.id)}`, { label });
      console.log(`${C.green}Renamed:${C.reset} ${a.id} → ${label}`);
    })());

  for (const [name, status] of [["enable", "active"], ["disable", "disabled"]] as const) {
    acc
      .command(`${name} <id>`)
      .description(name === "enable" ? "Put an account back in the rotation (a Claude sign-in is proved first)" : "Take an account out of the rotation")
      .action((id: string) => run(async () => {
        const a = findAccount(await listAccounts(), id);
        await ppmApiRequest("PATCH", `${base(a.provider)}/${encodeURIComponent(a.id)}`, { status }, { timeoutMs: 90_000 });
        console.log(`${C.green}${name === "enable" ? "Enabled" : "Disabled"}:${C.reset} ${a.id}`);
      })());
  }

  acc
    .command("remove <id>")
    .description("Remove an account and its stored sign-in (cannot be undone)")
    .option("--yes", "Confirm the removal")
    .action((id: string, opts: { yes?: boolean }) => run(async () => {
      const a = findAccount(await listAccounts(), id);
      if (!opts.yes) fail(`This forgets ${a.label ?? a.id} and its sign-in for good; run again with --yes`);
      await ppmApiRequest("DELETE", `${base(a.provider)}/${encodeURIComponent(a.id)}`);
      console.log(`${C.green}Removed:${C.reset} ${a.id}`);
    })());

  acc
    .command("settings")
    .description("Show or change how chats rotate across the accounts")
    .option("--provider <provider>", "claude or codex", "claude")
    .option("--strategy <strategy>", CLAUDE_STRATEGIES.join(", "))
    .option("--max-retry <n>", "Claude: how many other accounts a failed turn tries")
    .option("--cooldown <on|off>", "Claude: rest an account that hit its limit")
    .action((opts: { provider: string; strategy?: string; maxRetry?: string; cooldown?: string }) => run(async () => {
      const p = providerOption(opts.provider)!;
      if (opts.strategy && !CLAUDE_STRATEGIES.includes(opts.strategy)) fail(`--strategy is one of ${CLAUDE_STRATEGIES.join(", ")}`);
      if (p === "codex") {
        if (opts.maxRetry || opts.cooldown) fail("--max-retry and --cooldown are Claude settings");
        if (opts.strategy) await ppmApiRequest("PUT", "/codex-accounts/strategy", { strategy: opts.strategy });
        const { strategy } = await ppmApiRequest<{ strategy: string }>("GET", "/codex-accounts");
        return void console.log(`Strategy: ${strategy}`);
      }
      const body: Record<string, unknown> = {};
      if (opts.strategy) body.strategy = opts.strategy;
      if (opts.maxRetry !== undefined) {
        if (!/^\d+$/.test(opts.maxRetry)) fail("--max-retry takes a whole number");
        body.maxRetry = Number(opts.maxRetry);
      }
      if (opts.cooldown !== undefined) {
        if (opts.cooldown !== "on" && opts.cooldown !== "off") fail("--cooldown takes on or off");
        body.cooldownEnabled = opts.cooldown === "on";
      }
      const s = Object.keys(body).length
        ? await ppmApiRequest<Record<string, unknown>>("PUT", "/accounts/settings", body)
        : await ppmApiRequest<Record<string, unknown>>("GET", "/accounts/settings");
      console.log(`Strategy:  ${s.strategy}\nMax retry: ${s.maxRetry}\nCooldown:  ${s.cooldownEnabled ? "on" : "off"}\nActive:    ${s.activeCount}`);
    })());
}
