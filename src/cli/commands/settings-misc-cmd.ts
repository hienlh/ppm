import type { Command } from "commander";
import { C, fail, run } from "./chat-cmd-request.ts";
import { settingsRequest } from "../utils/settings-request.ts";
import { refuseInAiChat } from "../utils/ai-chat-refusal.ts";

/**
 * `ppm keybindings`, `ppm proxy` and `ppm device-name`, through the routes Settings calls, so
 * every open PPM picks the change up at once.
 *
 * From an AI chat (advisory, see `ai-chat-refusal.ts`): keybindings are not changed, since they
 * decide which key answers a card; the proxy is not switched on or given a new key, and its key
 * is not revealed, since it spends the user's accounts.
 */

type ProxyStatus = {
  enabled: boolean; authKey: string | null; requestCount: number;
  localEndpoint: string; localOpenAiEndpoint: string; proxyEndpoint: string | null; openAiEndpoint: string | null;
};

const COMMAND_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function printProxy(p: ProxyStatus): void {
  console.log(`Enabled:   ${p.enabled ? "yes" : "no"}`);
  console.log(`Auth key:  ${p.authKey ?? "(none)"}`);
  console.log(`Anthropic: ${p.proxyEndpoint ?? p.localEndpoint}`);
  console.log(`OpenAI:    ${p.openAiEndpoint ?? p.localOpenAiEndpoint}`);
  console.log(`Requests:  ${p.requestCount}`);
}

export function registerKeybindingCommands(program: Command): void {
  const kb = program.command("keybindings").description("List or change PPM's keyboard shortcuts");
  const where = "Settings → Keyboard Shortcuts";

  kb
    .command("list")
    .description("List the shortcuts changed from their defaults")
    .option("--json", "Print JSON")
    .action((opts: { json?: boolean }) => run(async () => {
      const overrides = await settingsRequest<Record<string, string>>("GET", "/keybindings");
      if (opts.json) console.log(JSON.stringify(overrides, null, 2));
      else if (Object.keys(overrides).length === 0) console.log(`${C.dim}Every shortcut is at its default.${C.reset}`);
      else for (const [id, keys] of Object.entries(overrides)) console.log(`${id}  ${keys}`);
    })());

  kb
    .command("set <command> <keys>")
    .description("Bind a command to keys, e.g. open-chat Mod+Shift+L (Mod is Ctrl, or Cmd on a Mac)")
    .action((command: string, keys: string) => run(async () => {
      refuseInAiChat("A keyboard shortcut", where);
      if (!COMMAND_ID.test(command)) fail(`"${command}" is not a command id (e.g. open-chat, toggle-sidebar)`);
      if (!keys.trim() || keys.length > 60) fail("Give the keys as e.g. Mod+Shift+L");
      await settingsRequest("PUT", "/keybindings", { [command]: keys.trim() });
      console.log(`${C.green}Bound:${C.reset} ${command} → ${keys.trim()}`);
    })());

  kb
    .command("reset [command]")
    .description("Put one shortcut, or every one, back to its default")
    .action((command: string | undefined) => run(async () => {
      refuseInAiChat("A keyboard shortcut", where);
      const ids = command ? [command] : Object.keys(await settingsRequest<Record<string, string>>("GET", "/keybindings"));
      if (ids.length === 0) return void console.log(`${C.dim}Every shortcut is already at its default.${C.reset}`);
      await settingsRequest("PUT", "/keybindings", Object.fromEntries(ids.map((id) => [id, null])));
      console.log(`${C.green}Reset:${C.reset} ${command ?? `${ids.length} shortcut(s)`}`);
    })());
}

export function registerProxyCommands(program: Command): void {
  const proxy = program.command("proxy").description("Show or change the API proxy that lends your accounts to other tools");
  const where = "Settings → API Proxy";

  proxy
    .command("get")
    .description("Show the proxy's state and endpoints; the auth key only as its first characters")
    .option("--reveal", "Print the whole auth key")
    .option("--json", "Print JSON")
    .action((opts: { reveal?: boolean; json?: boolean }) => run(async () => {
      if (opts.reveal) refuseInAiChat("Revealing the proxy's auth key", where);
      const status = await settingsRequest<ProxyStatus>("GET", `/proxy${opts.reveal ? "?reveal=1" : ""}`);
      if (opts.json) console.log(JSON.stringify(status, null, 2));
      else printProxy(status);
    })());

  proxy
    .command("set <setting> <value>")
    .description("Switch the proxy on or off: set enabled true|false")
    .action((setting: string, value: string) => run(async () => {
      refuseInAiChat("The API proxy", where);
      if (setting !== "enabled") fail(`Only "enabled" can be set here; give the key with \`ppm proxy key generate\``);
      if (value !== "true" && value !== "false") fail("enabled takes true or false");
      const status = await settingsRequest<ProxyStatus>("PUT", "/proxy", { enabled: value === "true" });
      console.log(`${C.green}Proxy:${C.reset} ${status.enabled ? "on" : "off"}`);
    })());

  proxy
    .command("key")
    .description("Manage the proxy's auth key")
    .command("generate")
    .description("Replace the auth key with a new random one; the old key stops working")
    .action(() => run(async () => {
      refuseInAiChat("The proxy's auth key", where);
      const status = await settingsRequest<ProxyStatus>("PUT", "/proxy", { generateKey: true });
      console.log(`${C.green}New auth key:${C.reset} ${status.authKey} (see it whole with \`ppm proxy get --reveal\`)`);
    })());
}

export function registerDeviceNameCommand(program: Command): void {
  program
    .command("device-name <name>")
    .description("Name this machine, as PPM's title and PPM Cloud show it (\"\" clears it)")
    .action((name: string) => run(async () => {
      const r = await settingsRequest<{ device_name: string; cloud_synced: boolean; cloud_error?: string }>("PUT", "/device-name", { device_name: name });
      console.log(`${C.green}Device name:${C.reset} ${r.device_name || "(none)"}${r.cloud_synced ? " (PPM Cloud updated)" : ""}`);
      if (r.cloud_error) console.log(`${C.yellow}PPM Cloud not updated:${C.reset} ${r.cloud_error}`);
    })());
}
