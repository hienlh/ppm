import type { Command } from "commander";
import { C, run } from "./chat-cmd-request.ts";
import { settingsRequest } from "../utils/settings-request.ts";
import { refuseInAiChat } from "../utils/ai-chat-refusal.ts";
import { promptSecret } from "../utils/secret-prompt.ts";

/**
 * `ppm telegram-bot`: the bot notifications are sent through (Settings → Notifications →
 * Telegram), through `/api/settings/telegram`. The Assistant's own bot is `ppm ppmbot token`.
 *
 * The token is typed at a terminal, checked with Telegram by the server before it is kept, and
 * only ever shown as its first characters. From an AI chat (advisory) it is neither set nor
 * removed: setting it needs the token, removing it stops notifications reaching the user.
 */

const WHERE = "Settings → Notifications → Telegram";

/** The bot as the server shows it: the token's first characters only. */
interface MaskedBot { bot_token: string; bot_username: string | null }

function printBot(bot: MaskedBot): void {
  if (!bot.bot_token) return void console.log(`${C.dim}No notification bot. Set one with: ppm telegram-bot set --token-prompt${C.reset}`);
  console.log(`Bot:   ${bot.bot_username ? `@${bot.bot_username}` : "(name not known yet)"}`);
  console.log(`Token: ${bot.bot_token}`);
}

export function registerTelegramBotCommands(program: Command): void {
  const bot = program.command("telegram-bot").description("The Telegram bot notifications are sent through");

  bot
    .command("get")
    .description("Show the bot (its token only as the first characters)")
    .option("--json", "Print JSON")
    .action((opts: { json?: boolean }) => run(async () => {
      const current = await settingsRequest<MaskedBot>("GET", "/telegram");
      if (opts.json) console.log(JSON.stringify(current, null, 2));
      else printBot(current);
    })());

  bot
    .command("set")
    .description("Replace the bot's token, typed at the terminal; Telegram is asked whether it is real first")
    .requiredOption("--token-prompt", "Type the token from @BotFather at the terminal")
    .action(() => run(async () => {
      const token = await promptSecret("Bot token from @BotFather: ", "The notification bot's token", WHERE);
      if (!token) throw new Error("No token typed; nothing was changed. Remove the bot with `ppm telegram-bot remove`.");
      const saved = await settingsRequest<MaskedBot>("PUT", "/telegram", { bot_token: token });
      console.log(`${C.green}Saved:${C.reset} ${saved.bot_username ? `@${saved.bot_username}` : "bot"}. Connect a chat with \`ppm notify telegram connect\`.`);
    })());

  bot
    .command("remove")
    .description("Forget the bot; no Telegram notification is sent until another is set")
    .action(() => run(async () => {
      refuseInAiChat("Removing the notification bot", WHERE);
      await settingsRequest("PUT", "/telegram", { bot_token: "" });
      console.log(`${C.green}Notification bot removed.${C.reset}`);
    })());

  bot
    .command("test")
    .description("Send a test notification to every connected chat")
    .action(() => run(async () => {
      await settingsRequest("POST", "/telegram/test", {});
      console.log(`${C.green}Sent.${C.reset}`);
    })());
}
