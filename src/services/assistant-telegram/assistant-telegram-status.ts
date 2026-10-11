/**
 * `/status` on Telegram: which chats need the user today, across every project — the same
 * overview the Assistant's `chats_attention` tool reads, cut to the ten most urgent. A chat
 * waiting on a card gets that card right after the list, with the same buttons (and the same
 * Allow rule) as a watched chat's card, so it can be answered without opening PPM.
 *
 * Titles are names users and other AIs gave: redacted and escaped like anything else sent. A
 * chat's name links to it only when the link is one Telegram opens (public https); otherwise
 * one plain "Open in PPM" line closes the message, as every other link the bridge sends.
 */
import { chatsAttention, parseAttentionSince, type AttentionChat, type ChatsAttention } from "../assistant-hub/chat-attention.service.ts";
import { chatControl, type LiveApprovalCard } from "../chat-control/chat-control.ts";
import { escapeTelegramHtml, truncateText } from "../notification-format.ts";
import { notificationLink } from "../notification-link.ts";
import { redactForTelegram } from "../telegram/telegram-html-format.ts";
import type { RelayedCard } from "./assistant-telegram-cards.ts";
import { chatLink, isPublicHttpsUrl, OPEN_IN_PPM } from "./assistant-telegram-links.ts";

/** How many chats one `/status` lists. */
export const STATUS_MAX_ITEMS = 10;
const TITLE_MAX = 60;
const ERROR_MAX = 120;

export interface StatusDeps {
  attention?: () => ChatsAttention;
  /** The card a chat shows now, in full (the overview keeps only a shortened copy). */
  liveCard?: (sessionId: string) => LiveApprovalCard | null;
  link?: (project: string, providerId: string | null, sessionId: string) => Promise<string>;
  /** Where "Open in PPM" goes when no chat can be linked by name. */
  homeLink?: () => Promise<string>;
}

export interface StatusReply {
  html: string;
  cards: RelayedCard[];
}

type Group = keyof typeof ICON;
type Line = { group: Group; chat: AttentionChat; text: string; card?: LiveApprovalCard };

const ICON = {
  needsDecision: "🔐", running: "⏳", lostCards: "⚠️", stopped: "⛔", finishedUnread: "✅", finishedRead: "☑️",
} as const;

/** What `/status` answers. */
export async function buildStatus(deps: StatusDeps = {}): Promise<StatusReply> {
  const attention = (deps.attention ?? todaysAttention)();
  const liveCard = deps.liveCard ?? ((id) => chatControl()?.liveState(id)?.card ?? null);
  const link = deps.link ?? chatLink;

  const lines: Line[] = [];
  for (const c of attention.needsDecision) {
    const card = liveCard(c.sessionId);
    const queued = c.queuedCards > 0 ? ` (+${c.queuedCards} more)` : "";
    lines.push({ group: "needsDecision", chat: c, text: `waiting for your decision${queued}`, ...(card ? { card } : {}) });
  }
  for (const c of attention.running) lines.push({ group: "running", chat: c, text: "running" });
  for (const c of attention.lostCards) lines.push({ group: "lostCards", chat: c, text: `its ${c.kind} card was lost when PPM restarted — open it in PPM` });
  for (const c of attention.stopped) lines.push({ group: "stopped", chat: c, text: `stopped: ${firstLine(c.error)}` });
  for (const c of attention.finishedUnread) lines.push({ group: "finishedUnread", chat: c, text: "finished, not read yet" });
  for (const c of attention.finishedRead) lines.push({ group: "finishedRead", chat: c, text: "finished" });

  const shown = lines.slice(0, STATUS_MAX_ITEMS);
  const more = lines.length - shown.length + Object.values(attention.more).reduce((n, m) => n + (m ?? 0), 0);
  if (shown.length === 0) {
    return { html: "Nothing needs you today: no chat is waiting, running or finished since midnight.", cards: [] };
  }

  let anyLinked = false;
  const rendered = await Promise.all(shown.map(async (line) => {
    const name = escapeTelegramHtml(chatName(line.chat));
    const url = line.chat.project ? await link(line.chat.project, line.chat.providerId, line.chat.sessionId).catch(() => null) : null;
    const linked = url && isPublicHttpsUrl(url);
    if (linked) anyLinked = true;
    const project = line.chat.project ? ` · ${escapeTelegramHtml(redactForTelegram(line.chat.project))}` : "";
    const label = linked ? `<a href="${escapeTelegramHtml(url)}">${name}</a>` : `<b>${name}</b>`;
    return `${ICON[line.group]} ${label}${project} — ${escapeTelegramHtml(redactForTelegram(line.text))}`;
  }));

  const parts = ["<b>Your chats today</b>", "", ...rendered];
  if (more > 0) parts.push("", `<i>${more} more in PPM.</i>`);
  if (!anyLinked) {
    // No project: PPM's home page.
    const home = await (deps.homeLink ?? (() => notificationLink({ project: "", sessionId: "" })))().catch(() => null);
    if (home) parts.push("", `${escapeTelegramHtml(OPEN_IN_PPM)}: ${escapeTelegramHtml(home)}`);
  }
  const cards: RelayedCard[] = shown.flatMap((line) => line.card && line.chat.project ? [{
    targetSessionId: line.chat.sessionId,
    targetProject: line.chat.project,
    targetProvider: line.chat.providerId ?? "claude",
    targetTitle: chatName(line.chat),
    card: line.card,
  }] : []);
  return { html: parts.join("\n"), cards };
}

function todaysAttention(): ChatsAttention {
  const since = parseAttentionSince("today");
  return chatsAttention({ since: since.ok ? since.value : Date.now() - 24 * 3_600_000 });
}

/** A chat's name as the list shows it, plain (escaped by the caller). */
function chatName(c: AttentionChat): string {
  return truncateText(redactForTelegram((c.title ?? "").trim() || `Session ${c.sessionId.slice(0, 8)}`), TITLE_MAX);
}

function firstLine(text: string): string {
  return truncateText(text.split("\n").map((l) => l.trim()).find(Boolean) ?? "an error", ERROR_MAX);
}
