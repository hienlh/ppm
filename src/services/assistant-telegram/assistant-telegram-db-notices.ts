/**
 * Tells the user on Telegram that a chat's database tool waits on them, so they learn of it when
 * they are away from PPM: a `db_execute` change waiting for approval (and once more shortly before
 * it gives up), and a connection nobody has logged in to since PPM started. Sent as it happens,
 * whether or not a PPM screen shows the chat: the card itself says nothing to a phone.
 *
 * Notices only, with no Allow or Deny: approving a change takes PPM's password, and a login takes
 * the database's, and neither is ever asked for or taken on Telegram. Each notice says so, names
 * the project, the chat and the connection, and links to the chat in PPM.
 *
 * Sent to every connected chat (the send lane checks each again before every call), nothing when
 * none is. Quiet hours: an approval's notice is held and sent when they end if the change still
 * waits; the reminder and the login notice are dropped, since by then the chat has given up or
 * moved on, and the held notice already covers an approval that still waits. The login notice is
 * deduplicated where it is raised (`db-login-attention.ts`).
 */
import { dbApprovalBroker } from "../db-ai-tools/db-approval-broker.ts";
import { onVaultCardShown, type VaultCardShownListener } from "../vault/vault-unlock-broker.ts";
import { notificationLink } from "../notification-link.ts";
import { VAULT_TIER_LABELS, vaultSettingsPath, type VaultCardInput } from "../../shared/vault.ts";
import { dbAttentionEvents, type DbAttentionBus, type DbAttentionEvents } from "../db-ai-tools/db-attention-events.ts";
import { getSessionProjectName, getSessionProvider, getSessionTitle, resolveMigratedSession } from "../db.service.ts";
import { escapeTelegramHtml, truncateText } from "../notification-format.ts";
import { redactForTelegram } from "../telegram/telegram-html-format.ts";
import { chatControl } from "../chat-control/chat-control.ts";
import { chatService } from "../chat.service.ts";
import { assistantClock } from "../assistant-wake/assistant-clock.ts";
import { currentQuietWindowEnd } from "../assistant-wake/wake-quiet-hours.ts";
import { createLogger } from "../logger.ts";
import { MENTIONS_PASSWORD, PASSWORD_WITHHELD, type DbExecuteApprovalInput } from "../../shared/db-ai-tools.ts";
import { canSendTo, reachableChats } from "./assistant-telegram-access.ts";
import { placeLink } from "./assistant-telegram-links.ts";
import { sendMessageTask, type AssistantTelegramSendQueue } from "./assistant-telegram-send-queue.ts";
import { createQuietHold, type QuietHold, type QuietHoldDeps } from "./assistant-telegram-quiet-hold.ts";
import type { CardReminders, TelegramSilence } from "./assistant-telegram-silence.ts";
import type { AssistantTelegramCardsDesk } from "./assistant-telegram-cards-desk.ts";

const log = createLogger("assistant-telegram");

/** A notice that is also listed on the pinned card desk while it waits. */
interface DeskItem {
  key: string;
  title: (chat: DescribedChat) => string;
  stillWaiting: () => boolean;
}

/** How much of the SQL a notice repeats; the whole script is on the card in PPM. */
export const DB_NOTICE_SQL_MAX = 600;
const REASON_MAX = 300;
const NAME_MAX = 80;

export const ANSWER_IN_PPM = "Answer in PPM: approving needs PPM's password, which is never asked for here.";
export const LOGIN_IN_PPM = "Log in from PPM's Database panel, then ask the chat to try again. The password is never asked for here.";

/** Who a session is, as a notice names it. */
export interface DescribedChat {
  project: string;
  providerId: string | null;
  title: string;
}

/** Told when a notice went out without a sound: which chat it named and the link to it. */
type SilentSend = (chatId: string, messageId: number, about: { chat: DescribedChat; url: string | null }) => void;

export interface DbNoticesDeps {
  queue: AssistantTelegramSendQueue;
  /** The link that opens a chat in PPM. */
  chatLink: (project: string, providerId: string | null, sessionId: string) => Promise<string>;
  connectedChats?: () => string[];
  events?: Pick<DbAttentionBus, "on">;
  describe?: (sessionId: string) => DescribedChat;
  /** The id a session goes by now: Codex renames a new chat during its first turn. */
  canonical?: (sessionId: string) => string;
  /** Where vault cards are announced (the vault broker's by default; tests pass their own). */
  onVaultCard?: (listener: VaultCardShownListener) => () => void;
  /** The absolute link for a path inside PPM (Settings → Vault); `notificationLink` by default. */
  pathLink?: (path: string) => Promise<string>;
  /** Quiet hours, and whether a held approval still waits (tests pass a fake clock and window). */
  quiet?: QuietHoldDeps;
  /** Whether the user is at PPM, so a notice goes out without a sound. */
  silence?: TelegramSilence;
  /** The one reminder with a sound for an approval notice sent silently and left unanswered. */
  reminders?: CardReminders;
  /** The pinned card desk: an approval's notice is listed there while the change waits. */
  desk?: AssistantTelegramCardsDesk;
}

type Shown = DbAttentionEvents["approval_shown"];
type Held = Shown & { targetSessionId: string; card: { requestId: string } };

function realDescribe(sessionId: string): DescribedChat {
  const live = chatControl()?.liveState(sessionId);
  return {
    project: live?.projectName || getSessionProjectName(sessionId) || "",
    providerId: live?.providerId || getSessionProvider(sessionId),
    // The user's rename, else the title the chat shows (its provider's, from the first message).
    title: getSessionTitle(sessionId) || chatService.getSession(sessionId)?.title || "",
  };
}

const realQuiet: QuietHoldDeps = {
  clock: assistantClock,
  quietEnd: currentQuietWindowEnd,
  stillWaiting: (_sessionId, requestId) => dbApprovalBroker.has(requestId),
};

const name = (text: string, fallback: string): string =>
  escapeTelegramHtml(truncateText(redactForTelegram(text.replace(/\s+/g, " ").trim()) || fallback, NAME_MAX));

/** "Chat “Fix jobs” in api": who is asking, escaped. */
function whichChat(chat: DescribedChat): string {
  const title = `“${name(chat.title, "Untitled chat")}”`;
  return chat.project ? `Chat ${title} in <b>${name(chat.project, "")}</b>` : `Chat ${title}`;
}

function where(input: Pick<DbExecuteApprovalInput, "connectionName" | "database">): string {
  const conn = `<b>${name(input.connectionName, "a connection")}</b>`;
  return input.database ? `${conn} (database ${name(input.database, "")})` : conn;
}

/** Redacted first, so a cut cannot leave half a secret the redaction no longer recognises. */
const excerpt = (text: string, max: number): string => escapeTelegramHtml(truncateText(redactForTelegram(text), max));

const minutesLeft = (expiresAt: number, now: number): number => Math.max(1, Math.round((expiresAt - now) / 60_000));

export function approvalNoticeHtml(chat: DescribedChat, input: DbExecuteApprovalInput, expiresAt: number, now: number): string {
  const lines = [
    "🔐 <b>A database change is waiting for your approval</b>",
    "",
    `${whichChat(chat)} wants to run this on ${where(input)}:`,
    MENTIONS_PASSWORD.test(input.sql) ? `<i>${escapeTelegramHtml(PASSWORD_WITHHELD)}</i>` : `<pre>${excerpt(input.sql, DB_NOTICE_SQL_MAX)}</pre>`,
  ];
  const reason = input.reason?.trim();
  if (reason) lines.push(`Why: ${MENTIONS_PASSWORD.test(reason) ? `<i>${escapeTelegramHtml(PASSWORD_WITHHELD)}</i>` : excerpt(reason, REASON_MAX)}`);
  lines.push("", `Nothing runs unless you approve within ${minutesLeft(expiresAt, now)} minutes. ${ANSWER_IN_PPM}`);
  return lines.join("\n");
}

export function reminderNoticeHtml(chat: DescribedChat, input: DbExecuteApprovalInput, expiresAt: number, now: number): string {
  return [
    "⏰ <b>Still waiting: a database change</b>",
    "",
    `${whichChat(chat)} still waits for your approval to change ${where(input)}. `
      + `PPM gives up in ${minutesLeft(expiresAt, now)} minutes and nothing runs. ${ANSWER_IN_PPM}`,
  ].join("\n");
}

export function loginNoticeHtml(chat: DescribedChat, connectionName: string): string {
  return [
    "🔑 <b>A database needs you to log in</b>",
    "",
    `${whichChat(chat)} tried to use ${where({ connectionName })}, which asks for its password, and nobody has logged in to it since PPM started.`,
    LOGIN_IN_PPM,
  ].join("\n");
}

/** The closing line of every vault notice: the answer and the password belong to PPM. */
export const VAULT_ANSWER_IN_PPM = "Open PPM to answer it. The password is typed there, never here.";

export const OPEN_VAULT = "Open Vault";

/**
 * A vault card waits in a chat: which items, which tier and what is asked, with two ways into PPM
 * (the chat holding the card, and Settings → Vault on the item). Item names are the user's own.
 * Never a value (a card holds none), never the AI's own text (its stated purpose, the name it
 * proposes for a new item), and never a file or its name.
 */
export function vaultNoticeHtml(chat: DescribedChat, input: VaultCardInput): string {
  const who = whichChat(chat);
  const item = (n: string) => `<b>${name(n, "an item")}</b>`;
  let what: string;
  if (input.kind === "read-secure") {
    const names = input.items.filter((i) => input.requested.includes(i.id)).map((i) => item(i.name));
    const listed = names.slice(0, 5).join(", ") + (names.length > 5 ? ` and ${names.length - 5} more` : "");
    what = names.length === 1
      ? `${who} asks to read the <b>Secure</b> item ${listed}.`
      : `${who} asks to read ${names.length} <b>Secure</b> items: ${listed}.`;
  } else if (input.kind === "read-sealed") {
    what = `${who} asks to open the <b>Sealed</b> item ${item(input.item.name)}.`;
  } else {
    // The proposed name is the AI's own text, like its purpose: it stays in PPM.
    what = `${who} proposes saving a new item to the vault (suggested tier: <b>${VAULT_TIER_LABELS[input.suggestedTier]}</b>). `
      + "You see and settle the name, tier and value in PPM.";
  }
  const title = input.kind === "propose" ? "Save to the vault?" : "Vault unlock requested";
  return [`🔒 <b>${title}</b>`, "", what, "", VAULT_ANSWER_IN_PPM].join("\n");
}

/** The item Settings → Vault lands on for a card: the one it names, when it names one. */
export function vaultNoticeItem(input: VaultCardInput): string | null {
  if (input.kind === "read-sealed") return input.item.id;
  if (input.kind === "read-secure") return input.requested[0] ?? null;
  return null;
}

export class AssistantTelegramDbNotices {
  private offs: Array<() => void> = [];
  private readonly connectedChats: () => string[];
  private readonly describe: (sessionId: string) => DescribedChat;
  private readonly canonical: (sessionId: string) => string;
  private readonly quiet: QuietHoldDeps;
  /** Approvals shown in quiet hours, sent at their end if they still wait. */
  private readonly quietHold: QuietHold<Held>;

  constructor(private readonly deps: DbNoticesDeps) {
    this.connectedChats = deps.connectedChats ?? (() => reachableChats().map((c) => c.chatId));
    this.describe = deps.describe ?? realDescribe;
    this.canonical = deps.canonical ?? resolveMigratedSession;
    this.quiet = deps.quiet ?? realQuiet;
    this.quietHold = createQuietHold<Held>(this.quiet, (p) => this.sendApproval(p), "database approval notice");
  }

  attach(): void {
    if (this.offs.length) return;
    const events = this.deps.events ?? dbAttentionEvents;
    this.offs = [
      events.on("approval_shown", (p) => this.onShown(p)),
      events.on("approval_reminder", (p) => this.onReminder(p)),
      events.on("login_needed", (p) => this.onLogin(p)),
      (this.deps.onVaultCard ?? onVaultCardShown)((sessionId, _requestId, input) => {
        if (this.inQuietHours()) return void log.info("vault card: notice not sent in quiet hours");
        const itemId = vaultNoticeItem(input);
        this.send(sessionId, "vault card", (chat) => vaultNoticeHtml(chat, input), undefined, async () => [
          { label: OPEN_VAULT, url: await this.vaultLink(itemId) },
        ]);
      }),
    ];
  }

  detach(): void {
    for (const off of this.offs.splice(0)) off();
    this.quietHold.clear();
  }

  private onShown(p: Shown): void {
    if (this.quietHold.offer({ ...p, targetSessionId: p.sessionId, card: { requestId: p.requestId } })) return;
    this.sendApproval(p);
  }

  /** The approval's notice waits on a decision: sent silently, it gets one reminder while the change still waits. */
  private sendApproval(p: Shown): void {
    const desk: DeskItem = {
      key: `db:${p.requestId}`, stillWaiting: () => this.quiet.stillWaiting(p.sessionId, p.requestId),
      title: (chat) => `Database change from “${chat.title}”`,
    };
    this.send(p.sessionId, "db approval", (chat) => approvalNoticeHtml(chat, p.input, p.expiresAt, this.quiet.clock.now()), (chatId, messageId, about) => {
      this.deps.reminders?.schedule({
        chatId, messageId, label: "db approval",
        stillWaiting: () => this.quiet.stillWaiting(p.sessionId, p.requestId),
        project: about.chat.project, title: `Database change from “${about.chat.title}”`, url: about.url,
      });
    }, undefined, desk);
  }

  private onReminder(p: DbAttentionEvents["approval_reminder"]): void {
    if (this.inQuietHours()) return void log.info(`db approval ${p.requestId}: reminder not sent in quiet hours`);
    this.send(p.sessionId, "db approval reminder", (chat) => reminderNoticeHtml(chat, p.input, p.expiresAt, this.quiet.clock.now()));
  }

  private onLogin(p: DbAttentionEvents["login_needed"]): void {
    if (this.inQuietHours()) return void log.info(`db login for connection ${p.connectionId}: notice not sent in quiet hours`);
    this.send(p.sessionId, "db login", (chat) => loginNoticeHtml(chat, p.connectionName));
  }

  private inQuietHours(): boolean {
    try { return this.quiet.quietEnd() !== null; } catch { return false; }
  }

  /** The address of Settings → Vault, on `itemId` when given: an id only, behind PPM's sign-in. */
  private vaultLink(itemId: string | null): Promise<string> {
    return (this.deps.pathLink ?? ((path: string) => notificationLink({ project: "", sessionId: "", path })))(vaultSettingsPath(itemId));
  }

  private send(
    sessionId: string, label: string, render: (chat: DescribedChat) => string, onSilentSend?: SilentSend,
    extraLinks?: () => Promise<{ label: string; url: string }[]>, desk?: DeskItem,
  ): void {
    let chats: string[];
    try { chats = this.connectedChats().filter(canSendTo); } catch { chats = []; }
    if (!chats.length) return;
    void this.deliver(chats, sessionId, label, render, onSilentSend, extraLinks, desk).catch((e) => log.warn(`${label} notice for ${sessionId} not sent: ${(e as Error).message}`));
  }

  private async deliver(
    chats: string[], asked: string, label: string, render: (chat: DescribedChat) => string,
    onSilentSend?: SilentSend,
    extraLinks?: () => Promise<{ label: string; url: string }[]>,
    desk?: DeskItem,
  ): Promise<void> {
    // Held through quiet hours, or sent just as Codex renamed the chat: name and link the chat as it is now.
    let sessionId = asked;
    try { sessionId = this.canonical(asked); } catch { /* the id it was asked under */ }
    const chat = this.describe(sessionId);
    let html = render(chat);
    const url = await this.deps.chatLink(chat.project, chat.providerId, sessionId).catch(() => null);
    const extra = extraLinks ? await extraLinks().catch(() => []) : [];
    // Each link is a button when Telegram takes it (public https), else a line of the text.
    const links = [...(url ? [placeLink(url)] : []), ...extra.map((l) => placeLink(l.url, l.label))];
    for (const l of links) if (l.inline) html += `\n\n${l.inline}`;
    const buttons = links.flatMap((l) => (l.button ? [l.button] : []));
    for (const chatId of chats) {
      this.deps.queue.enqueue(chatId, sendMessageTask(this.deps.queue, chatId, {
        html,
        ...(buttons.length ? {
          markup: { inline_keyboard: buttons.map((b) => [b]) },
          fallbackHtml: `${html}${buttons.map((b) => `\n\n${escapeTelegramHtml(b.text)}: ${escapeTelegramHtml(b.url!)}`).join("")}`,
        } : {}),
      }, {
        label,
        silent: () => this.deps.silence?.inPpm() ?? false,
        onSent: (sent, info) => {
          if (onSilentSend && info.silent) onSilentSend(chatId, sent.message_id, { chat, url });
          // A notice with no Allow: on the desk it says the same and links to the chat.
          if (desk) {
            this.deps.desk?.put(chatId, {
              key: desk.key, icon: "🗄", project: chat.project, title: desk.title(chat), since: this.quiet.clock.now(),
              messageId: sent.message_id, stillWaiting: desk.stillWaiting,
              view: () => ({ html, rows: buttons.map((b) => [b]) }), groups: [],
            });
          }
        },
      }));
    }
  }
}
