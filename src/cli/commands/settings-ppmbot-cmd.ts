import type { Command } from "commander";
import { C, fail, run } from "./chat-cmd-request.ts";
import { settingsRequest } from "../utils/settings-request.ts";
import { refuseInAiChat } from "../utils/ai-chat-refusal.ts";
import { promptSecret } from "../utils/secret-prompt.ts";
import { printConnectLink } from "./settings-notify-cmd.ts";
import type { PPMBotTelegramStatus } from "../../shared/ppmbot-telegram.ts";

/**
 * `ppm ppmbot`: PPM Assistant on Telegram (Settings → PPM Assistant → Telegram), kept under the
 * `clawbot` routes PPMBot used. A connected chat can ask the Assistant for anything it can do.
 *
 * Writes go to the running PPM only: the bridge runs inside it, and the routes restart it when its
 * switch or bot changes — run in this process instead, they would start a bridge here.
 *
 * From an AI chat (advisory, see `ai-chat-refusal.ts`): the bridge is not switched on, no connect
 * link is made (it hands the Assistant to whoever opens it), and the bot token is not set.
 */

const WHERE = "Settings → PPM Assistant → Telegram";
const SERVER_ONLY = "The Assistant's Telegram bridge runs inside the running PPM.";

interface Options { enabled: boolean; show_tool_calls: boolean; debounce_ms: number }

const SETTINGS: Record<string, { key: keyof Options; parse: (v: string) => boolean | number | null }> = {
  enabled: { key: "enabled", parse: (v) => (v === "true" ? true : v === "false" ? false : null) },
  "show-tool-calls": { key: "show_tool_calls", parse: (v) => (v === "true" ? true : v === "false" ? false : null) },
  debounce: { key: "debounce_ms", parse: (v) => (/^\d+$/.test(v) && Number(v) <= 30_000 ? Number(v) : null) },
};

const write = <T>(method: string, sub: string, body?: unknown) => settingsRequest<T>(method, `/clawbot${sub}`, body, { serverOnly: SERVER_ONLY });

export function registerPpmbotCommands(program: Command): void {
  const bot = program.command("ppmbot").description("PPM Assistant on Telegram: its switch, bot and connected chats");

  bot
    .command("get")
    .description("Show the switch, the bot and whether the bridge is running")
    .option("--json", "Print JSON")
    .action((opts: { json?: boolean }) => run(async () => {
      const [options, status] = await Promise.all([
        settingsRequest<Options>("GET", "/clawbot"),
        settingsRequest<PPMBotTelegramStatus>("GET", "/clawbot/telegram"),
      ]);
      if (opts.json) return void console.log(JSON.stringify({ ...options, ...status, connect: { active: status.connect.active } }, null, 2));
      console.log(`Enabled:         ${options.enabled ? "yes" : "no"}${status.running ? " (running)" : ""}`);
      console.log(`Bot:             ${status.configured ? `@${status.botUsername ?? "bot"}` : "(none: ppm ppmbot token --token-prompt)"}`);
      console.log(`Show tool calls: ${options.show_tool_calls ? "yes" : "no"}`);
      console.log(`Debounce:        ${options.debounce_ms} ms`);
      console.log(`Chats:           ${status.chats.length}`);
      if (status.sharedWithNotifications) console.log(`${C.yellow}Notifications use this same bot, so their alerts land in these chats.${C.reset}`);
    })());

  bot
    .command("set <setting> <value>")
    .description("enabled true|false, show-tool-calls true|false, or debounce <0-30000 ms>")
    .action((setting: string, value: string) => run(async () => {
      const spec = SETTINGS[setting];
      if (!spec) fail(`"${setting}" is not a setting: ${Object.keys(SETTINGS).join(", ")}`);
      const parsed = spec.parse(value);
      if (parsed === null) fail(spec.key === "debounce_ms" ? "debounce takes a whole number of ms from 0 to 30000" : `${setting} takes true or false`);
      if (spec.key === "enabled" && parsed === true) refuseInAiChat("Switching on the Assistant's Telegram bridge", WHERE);
      const saved = await write<Options>("PUT", "", { [spec.key]: parsed });
      console.log(`${C.green}PPMBot:${C.reset} ${setting} ${String(saved[spec.key])}`);
    })());

  bot
    .command("token")
    .description("Set the Assistant's bot token (typed at the terminal) or remove it")
    .option("--token-prompt", "Type the token from @BotFather at the terminal")
    .option("--remove", "Remove the bot; the bridge stops")
    .action((opts: { tokenPrompt?: boolean; remove?: boolean }) => run(async () => {
      if (!!opts.tokenPrompt === !!opts.remove) fail("Give --token-prompt or --remove");
      const token = opts.remove ? "" : await promptSecret("Bot token from @BotFather: ", "The Assistant's bot token", WHERE);
      if (!opts.remove && !token) fail("No token typed; nothing was changed.");
      const saved = await write<{ bot_username: string | null }>("PUT", "/telegram", { bot_token: token });
      console.log(opts.remove ? `${C.green}Assistant bot removed.${C.reset}` : `${C.green}Saved:${C.reset} ${saved.bot_username ? `@${saved.bot_username}` : "bot"}`);
    })());

  bot
    .command("chats")
    .description("List the chats that may talk to the Assistant")
    .option("--json", "Print JSON")
    .action((opts: { json?: boolean }) => run(async () => {
      const status = await settingsRequest<PPMBotTelegramStatus>("GET", "/clawbot/telegram");
      if (opts.json) return void console.log(JSON.stringify(status.chats, null, 2));
      if (status.chats.length === 0) console.log(`${C.dim}No chat is connected.${C.reset}`);
      for (const chat of status.chats) console.log(`${chat.chatId}  ${chat.name}`);
    })());

  bot
    .command("revoke <chatId>")
    .description("Disconnect a chat: not one more message from it reaches the Assistant")
    .action((chatId: string) => run(async () => {
      if (!/^-?\d{1,20}$/.test(chatId)) fail("Give a Telegram chat id, as `ppm ppmbot chats` lists it");
      await write("DELETE", `/paired/${encodeURIComponent(chatId)}`);
      console.log(`${C.green}Revoked:${C.reset} ${chatId}`);
    })());

  bot
    .command("connect")
    .description("Make a one-time link: the chat that opens it may talk to the Assistant")
    .option("--cancel", "Withdraw the open link")
    .action((opts: { cancel?: boolean }) => run(async () => {
      if (opts.cancel) {
        await write("DELETE", "/telegram/connect");
        return void console.log(`${C.green}Link withdrawn.${C.reset}`);
      }
      refuseInAiChat("A link that hands the Assistant to a Telegram chat", WHERE);
      printConnectLink(await write<{ url: string; expiresAt: number }>("POST", "/telegram/connect", {}));
    })());
}
