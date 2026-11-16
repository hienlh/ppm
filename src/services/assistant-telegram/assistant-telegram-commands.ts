/**
 * The bot's commands: `/start`, `/new [claude|codex]`, `/sessions`, `/status`, `/tasks [project]`, `/stop`, `/quiet [on|off]`, `/help`. There is no
 * `/restart`: restarting PPM is a change, and a change goes through an approval card (the
 * Assistant can run `ppm restart` in a shell, which asks).
 *
 * Commands only reach here from a chat that passed the access checks.
 */
import { chatService } from "../chat.service.ts";
import { chatControl } from "../chat-control/chat-control.ts";
import { providerRegistry } from "../../providers/registry.ts";
import { ensureAssistantWorkDir } from "../assistant/assistant-work-dir.ts";
import { escapeTelegramHtml, truncateText } from "../notification-format.ts";
import { redactForTelegram } from "../telegram/telegram-html-format.ts";
import type { InlineKeyboardMarkup, TelegramBotCommand } from "../telegram/telegram-types.ts";
import type { SessionInfo } from "../../types/chat.ts";
import { assistantProviderIds, BindingError, boundSession, startNewSession } from "./assistant-telegram-binding.ts";
import { buildStatus, type StatusDeps } from "./assistant-telegram-status.ts";
import type { RelayedCard } from "./assistant-telegram-cards.ts";
import { quietWhileInPpm, setQuietWhileInPpm } from "./assistant-telegram-silence.ts";
import { createLogger } from "../logger.ts";
import { assistantNameForMessages } from "../assistant/assistant-settings.service.ts";

const log = createLogger("assistant-telegram");

export const BOT_COMMANDS: TelegramBotCommand[] = [
  { command: "new", description: "Start a new conversation (optionally: claude or codex)" },
  { command: "sessions", description: "Switch to another conversation" },
  { command: "status", description: "Which chats need you today" },
  { command: "tasks", description: "What to do first, across projects (optionally: a project)" },
  { command: "stop", description: "Stop the answer in progress" },
  { command: "quiet", description: "Silence the phone while you are at PPM (on/off)" },
  { command: "help", description: "What this bot can do" },
];

const SESSIONS_SHOWN = 8;

export interface ParsedCommand {
  name: string;
  args: string;
}

/** `/name@bot args` → `{ name, args }`; null for anything that is not a command. */
export function parseCommand(text: string | undefined): ParsedCommand | null {
  const m = /^\/([a-z][a-z0-9_]{0,31})(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text?.trim() ?? "");
  return m ? { name: m[1]!.toLowerCase(), args: (m[2] ?? "").trim() } : null;
}

export interface CommandContext {
  chatId: string;
  reply(html: string, markup?: InlineKeyboardMarkup): void;
  /** A button code that switches the chat to `sessionId` when pressed. */
  switchCode(sessionId: string): string;
  /** Shows another chat's card here, with buttons that answer that chat. */
  relayCard(card: RelayedCard): void;
  /** A button code that turns "quiet while at PPM" on or off when pressed. */
  quietCode?(on: boolean): string;
  /** `/tasks [project]`: the task deck, with no AI turn. */
  tasks?(args: string): void;
}

export interface CommandDeps {
  status?: StatusDeps;
}

/** /help, headed with the Assistant's name when it has one ("<b>Mi</b> — PPM Assistant, …"). */
export function helpText(name = assistantNameForMessages()): string {
  const head = name === "PPM Assistant"
    ? "<b>PPM Assistant</b> — the AI that works on your PPM."
    : `<b>${escapeTelegramHtml(name)}</b> — PPM Assistant, the AI that works on your PPM.`;
  return [head, ...HELP_BODY].join("\n");
}

const HELP_BODY = [
  "",
  "Just write a message: it answers here and in PPM's Assistant window, which share one conversation.",
  "Anything that changes something (sending a message into a chat, running a command…) shows a card first; answer it here or in PPM.",
  "",
  "/new — start a new conversation (<code>/new claude</code> or <code>/new codex</code>)",
  "/sessions — switch to another conversation",
  "/status — which chats need you today, with the cards they wait on",
  "/tasks — what to do first across your projects, one task at a time, with buttons to change its status (<code>/tasks &lt;project&gt;</code> for one project)",
  "/stop — stop the answer in progress",
  "/quiet — while you are at PPM, messages here arrive without a sound (<code>/quiet on</code>, <code>/quiet off</code>)",
  "/help — this message",
];

/** /help with no name set. */
export const HELP_TEXT = helpText("PPM Assistant");

function providerName(id: string): string {
  return providerRegistry.get(id)?.name ?? id;
}

export async function runCommand(cmd: ParsedCommand, ctx: CommandContext, deps: CommandDeps = {}): Promise<void> {
  log.info(`/${cmd.name} from Telegram chat ${ctx.chatId}`);
  try {
    switch (cmd.name) {
      case "start":
      case "help":
        return ctx.reply(helpText());
      case "new":
        return await newSession(cmd.args, ctx);
      case "sessions":
        return await listSessions(ctx);
      case "status":
        return await showStatus(ctx, deps.status);
      case "tasks":
        return ctx.tasks ? ctx.tasks(cmd.args) : ctx.reply("Tasks are not available here.");
      case "stop":
        return stopTurn(ctx);
      case "quiet":
        return quiet(cmd.args, ctx);
      default:
        return ctx.reply(`Unknown command /${escapeTelegramHtml(cmd.name)}. Send /help for the list.`);
    }
  } catch (e) {
    const message = e instanceof BindingError ? e.message : "Something went wrong; see PPM's log.";
    if (!(e instanceof BindingError)) log.warn(`/${cmd.name} failed for chat ${ctx.chatId}: ${(e as Error).message}`);
    ctx.reply(`⚠️ ${escapeTelegramHtml(message)}`);
  }
}

async function newSession(args: string, ctx: CommandContext): Promise<void> {
  const asked = args.split(/\s+/)[0]?.toLowerCase() || undefined;
  if (asked && !assistantProviderIds().includes(asked)) {
    const known = assistantProviderIds().map((id) => `<code>${escapeTelegramHtml(id)}</code>`).join(", ");
    return ctx.reply(`PPM Assistant cannot run on "${escapeTelegramHtml(asked)}". Try: ${known || "none available"}.`);
  }
  const binding = await startNewSession(ctx.chatId, asked);
  ctx.reply(`🆕 New conversation on <b>${escapeTelegramHtml(providerName(binding.providerId))}</b>. Send a message to begin.`);
}

/** The newest Assistant sessions across every provider that runs them. */
async function recentSessions(): Promise<SessionInfo[]> {
  const dir = ensureAssistantWorkDir();
  const lists = await Promise.all(assistantProviderIds().map((id) =>
    chatService.listSessions(id, dir, { limit: SESSIONS_SHOWN }).catch(() => [] as SessionInfo[])));
  const when = (s: SessionInfo) => Date.parse(s.updatedAt ?? s.createdAt) || 0;
  return lists.flat().sort((a, b) => when(b) - when(a)).slice(0, SESSIONS_SHOWN);
}

async function listSessions(ctx: CommandContext): Promise<void> {
  const sessions = await recentSessions();
  if (!sessions.length) return ctx.reply("No conversations yet. Send a message to start one.");
  const current = boundSession(ctx.chatId)?.sessionId;
  const rows = sessions.map((s) => {
    const title = truncateText(redactForTelegram(s.title || "Untitled"), 40);
    const mark = s.id === current ? "● " : "";
    return [{ text: `${mark}${title} · ${providerName(s.providerId)}`, callback_data: ctx.switchCode(s.id) }];
  });
  ctx.reply("Pick the conversation to continue here (● is the current one):", { inline_keyboard: rows });
}

async function showStatus(ctx: CommandContext, deps?: StatusDeps): Promise<void> {
  const status = await buildStatus(deps);
  ctx.reply(status.html);
  // After the list: each card names its chat, and the list said which chat waits on what.
  for (const card of status.cards) ctx.relayCard({ ...card, askedOnPhone: true });
}

/** What "quiet while at PPM" is, said the same way by `/quiet` and its button. */
export function quietStatusHtml(on: boolean): string {
  return on
    ? "🔕 <b>Quiet while you are at PPM: on.</b>\nWhile you are using PPM (or typed there in the last 5 minutes), messages here arrive without a sound. "
      + "A card left unanswered for 5 minutes is sent once more with a sound. Send /quiet off to turn it off."
    : "🔔 <b>Quiet while you are at PPM: off.</b>\nEvery message here arrives with a sound, as before. Send /quiet on to turn it on.";
}

function quiet(args: string, ctx: CommandContext): void {
  const asked = args.toLowerCase();
  if (asked === "on" || asked === "off") return ctx.reply(quietStatusHtml(setQuietWhileInPpm(asked === "on")));
  if (asked) return ctx.reply("Send <code>/quiet</code>, <code>/quiet on</code> or <code>/quiet off</code>.");
  const on = quietWhileInPpm();
  const markup: InlineKeyboardMarkup | undefined = ctx.quietCode
    ? { inline_keyboard: [[{ text: on ? "Turn off" : "Turn on", callback_data: ctx.quietCode(!on) }]] }
    : undefined;
  ctx.reply(quietStatusHtml(on), markup);
}

function stopTurn(ctx: CommandContext): void {
  const bound = boundSession(ctx.chatId);
  const live = bound ? chatControl()?.liveState(bound.sessionId) : null;
  if (!bound || !live?.running) return ctx.reply("Nothing is running.");
  chatControl()?.cancelTurn(bound.sessionId, "telegram");
  ctx.reply("⏹ Stopping…");
}
