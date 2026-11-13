import type { Command } from "commander";
import { C, fail, run } from "./chat-cmd-request.ts";
import { ppmApiRequest } from "../utils/settings-request.ts";
import { refuseInAiChat } from "../utils/ai-chat-refusal.ts";
import { promptSecret } from "../utils/secret-prompt.ts";
import {
  MAX_NOTIFICATION_DELAY_SECONDS, NOTIFICATION_EVENTS, NOTIFICATION_EVENT_COPY,
  type NotificationSettings, type NtfyStatus, type PushStatus, type TelegramNotifyStatus,
} from "../../shared/notification-settings.ts";

/**
 * `ppm notify`: what PPM notifies about and when, the ntfy topic, the notification bot's chats
 * and a push test, through the routes Settings → Notifications calls, so every open PPM refreshes.
 *
 * From an AI chat (advisory, see `ai-chat-refusal.ts`) nothing that would keep a notification
 * from reaching the user is done — an event or channel switched off, the ntfy topic or a chat
 * removed — nor anything that sends notification text somewhere new (an ntfy server, a connect
 * link for another chat). Subscribing a browser to push stays in that browser.
 */

const WHERE = "Settings → Notifications";
const CHANNELS = ["telegram", "ntfy"] as const;

/** A one-time Telegram link: whoever opens it first is connected, so it is shown to a person only. */
export function printConnectLink(link: { url: string; expiresAt: number }): void {
  console.log(`${C.green}Open this in Telegram:${C.reset} ${link.url}`);
  console.log(`${C.dim}Works once, until ${new Date(link.expiresAt).toLocaleTimeString()}${C.reset}`);
}

const notifications = <T>(method: string, sub: string, body?: unknown, serverOnly?: string) =>
  ppmApiRequest<T>(method, `/notifications${sub}`, body, { serverOnly });

function printSettings(s: NotificationSettings, ntfy: NtfyStatus, tg: TelegramNotifyStatus, push: PushStatus): void {
  for (const e of NOTIFICATION_EVENTS) console.log(`${e.padEnd(17)} ${s.events[e] ? "on " : "off"}  ${C.dim}${NOTIFICATION_EVENT_COPY[e].label}${C.reset}`);
  console.log(`delay             ${s.delay_seconds}s`);
  console.log(`telegram          ${s.telegram ? "on " : "off"}  ${C.dim}${tg.configured ? `@${tg.botUsername ?? "bot"}, ${tg.chats.length} chat(s)` : "no bot (ppm telegram-bot set)"}${C.reset}`);
  console.log(`ntfy              ${s.ntfy ? "on " : "off"}  ${C.dim}${ntfy.configured ? `${ntfy.server}/${ntfy.topic}${ntfy.tokenSet ? " (token set)" : ""}` : "not set up"}${C.reset}`);
  console.log(`push              ${C.dim}${push.devices.length} browser(s); turned on in each browser${C.reset}`);
}

export function registerNotifyCommands(program: Command): void {
  const notify = program.command("notify").description("What PPM notifies you about, and through which channels");

  notify
    .command("get")
    .description("Show the events, the delay and the channels")
    .option("--json", "Print JSON")
    .action((opts: { json?: boolean }) => run(async () => {
      const [settings, ntfy, telegram, push] = await Promise.all([
        notifications<NotificationSettings>("GET", "/settings"),
        notifications<NtfyStatus>("GET", "/ntfy"),
        notifications<TelegramNotifyStatus>("GET", "/telegram"),
        notifications<PushStatus>("GET", "/push"),
      ]);
      if (opts.json) console.log(JSON.stringify({ settings, ntfy, telegram: { ...telegram, connect: undefined }, pushDevices: push.devices.length }, null, 2));
      else printSettings(settings, ntfy, telegram, push);
    })());

  notify
    .command("set <event> <state>")
    .description(`Switch an event (${NOTIFICATION_EVENTS.join(", ")}) or a channel (telegram, ntfy) on or off`)
    .action((event: string, state: string) => run(async () => {
      if (state !== "on" && state !== "off") fail("Give on or off");
      const isChannel = (CHANNELS as readonly string[]).includes(event);
      if (!isChannel && !(NOTIFICATION_EVENTS as readonly string[]).includes(event)) {
        fail(`"${event}" is not an event or channel: ${[...NOTIFICATION_EVENTS, ...CHANNELS].join(", ")}`);
      }
      if (state === "off") refuseInAiChat("Switching a notification off", WHERE);
      const on = state === "on";
      await notifications("PUT", "/settings", isChannel ? { [event]: on } : { events: { [event]: on } });
      console.log(`${C.green}Notifications:${C.reset} ${event} ${state}`);
    })());

  notify
    .command("delay <seconds>")
    .description(`Wait this long, and send only if nobody has looked by then (0 sends at once; at most ${MAX_NOTIFICATION_DELAY_SECONDS})`)
    .action((seconds: string) => run(async () => {
      const n = Number(seconds);
      if (!/^\d+$/.test(seconds) || n > MAX_NOTIFICATION_DELAY_SECONDS) fail(`Give a whole number of seconds from 0 to ${MAX_NOTIFICATION_DELAY_SECONDS}`);
      await notifications("PUT", "/settings", { delay_seconds: n });
      console.log(`${C.green}Delay:${C.reset} ${n}s`);
    })());

  registerNtfyCommands(notify);
  registerNotifyTelegramCommands(notify);

  notify
    .command("push")
    .description("Browser push (subscribing is done in each browser)")
    .command("test")
    .description("Send a test push to every subscribed browser, or one")
    .option("--device <id>", "Only this browser (see `ppm notify get --json`)")
    .action((opts: { device?: string }) => run(async () => {
      const r = await notifications<{ sent: number }>("POST", "/push/test", opts.device ? { id: opts.device } : {});
      console.log(`${C.green}Sent:${C.reset} ${r.sent} browser(s)`);
    })());
}

function registerNtfyCommands(notify: Command): void {
  const ntfy = notify.command("ntfy").description("The ntfy server and topic notifications are published to");

  ntfy
    .command("set")
    .description("Set the server and topic; the server is checked first. A new server drops the old server's token")
    .option("--server <url>", "e.g. https://ntfy.sh (default: the current one)")
    .option("--topic <topic>", "1 to 64 letters, digits, - or _ (default: the current one)")
    .option("--token-prompt", "Type an access token at the terminal")
    .action((opts: { server?: string; topic?: string; tokenPrompt?: boolean }) => run(async () => {
      refuseInAiChat("Where notifications are published", WHERE);
      const current = await notifications<NtfyStatus>("GET", "/ntfy");
      const server = opts.server ?? current.server;
      const topic = opts.topic ?? current.topic;
      if (!server || !topic) fail("Give --server and --topic");
      const body: Record<string, string> = { server, topic };
      if (opts.tokenPrompt) body.token = await promptSecret("ntfy access token (blank for none): ", "An ntfy access token", WHERE);
      const next = await notifications<NtfyStatus>("PUT", "/ntfy", body);
      console.log(`${C.green}ntfy:${C.reset} ${next.server}/${next.topic}${next.tokenSet ? " (token set)" : ""}`);
      if (current.tokenSet && !next.tokenSet && !opts.tokenPrompt) console.log(`${C.yellow}The old server's token was dropped:${C.reset} it is never sent to another server.`);
    })());

  ntfy
    .command("remove")
    .description("Stop publishing to ntfy and forget the server, topic and token")
    .action(() => run(async () => {
      refuseInAiChat("Removing a notification channel", WHERE);
      await notifications("DELETE", "/ntfy");
      console.log(`${C.green}ntfy removed.${C.reset}`);
    })());

  ntfy
    .command("test")
    .description("Publish a test notification")
    .action(() => run(async () => {
      await notifications("POST", "/ntfy/test", {});
      console.log(`${C.green}Sent.${C.reset}`);
    })());
}

function registerNotifyTelegramCommands(notify: Command): void {
  const tg = notify.command("telegram").description("The Telegram chats notifications go to (the bot: `ppm telegram-bot`)");

  tg
    .command("chats")
    .description("List the chats receiving notifications")
    .option("--json", "Print JSON")
    .action((opts: { json?: boolean }) => run(async () => {
      const status = await notifications<TelegramNotifyStatus>("GET", "/telegram");
      if (opts.json) return void console.log(JSON.stringify(status.chats, null, 2));
      if (!status.configured) console.log(`${C.dim}No bot yet: ppm telegram-bot set --token-prompt${C.reset}`);
      else if (status.chats.length === 0) console.log(`${C.dim}No chat connected: ppm notify telegram connect${C.reset}`);
      for (const chat of status.chats) console.log(`${chat.chatId}  ${chat.name}`);
    })());

  tg
    .command("remove <chatId>")
    .description("Stop sending notifications to a chat")
    .action((chatId: string) => run(async () => {
      refuseInAiChat("Removing a notification chat", WHERE);
      await notifications("DELETE", `/telegram/chats/${encodeURIComponent(chatId)}`);
      console.log(`${C.green}Removed:${C.reset} ${chatId}`);
    })());

  tg
    .command("connect")
    .description("Make a one-time link: the chat that opens it receives notifications")
    .option("--cancel", "Withdraw the open link")
    .action((opts: { cancel?: boolean }) => run(async () => {
      const serverOnly = "A connect link waits for its chat inside the running PPM.";
      if (opts.cancel) {
        await notifications("DELETE", "/telegram/connect", undefined, serverOnly);
        return void console.log(`${C.green}Link withdrawn.${C.reset}`);
      }
      refuseInAiChat("A link that connects a chat to notifications", WHERE);
      const link = await notifications<{ url: string; expiresAt: number }>("POST", "/telegram/connect", {}, serverOnly);
      printConnectLink(link);
    })());
}
