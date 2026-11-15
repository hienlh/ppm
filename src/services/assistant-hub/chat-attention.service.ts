import { getAllUnread, getDb, resolveMigratedSession, type UnreadEntry } from "../db.service.ts";
import { chatControl, type LiveApprovalCard, type LiveChatState } from "../chat-control/chat-control.ts";
import { decidingInput } from "../chat-control/approval-deciding-input.ts";
import { turnEndsSince, type TurnEnd } from "../session-trace/turn-ends-query.ts";
import { isAssistantSession } from "../assistant/assistant-session.ts";
import { cleanSummaryText } from "../assistant/assistant-ui-summary.ts";
import { watchedChatTitle } from "../assistant-watch/watched-chat-title.ts";
import { isAssistantProject } from "../../shared/assistant-project.ts";
import type { NormalizedQuestion } from "../../shared/approval-questions.ts";
import type { AssistantCard, AssistantCardKind } from "../../shared/assistant-cards.ts";
import { assistantCards as cardStore } from "../assistant-cards/assistant-cards.service.ts";

/**
 * "Which chats need me?" across every project, whether or not a chat is open anywhere: the
 * PPM Assistant's own cards still waiting on the user (a manager's decision, an urgent report, a
 * held rules change…), the chat cards waiting for an answer, what is running, what finished or
 * stopped on an error, and the cards a restart took away. Built only from what PPM records — the
 * Assistant's card store, the live chats in this process, the unread marks, the session trace —
 * never guessed from a transcript.
 *
 * A chat lands in one group only, the most urgent that fits. Titles are names users and other
 * AIs gave, so they are cleaned like any other screen text; a waiting card's deciding part is
 * shown verbatim (`decidingInput`), only shortened for an overview.
 */

export const ATTENTION_GROUP_MAX = 20;
/** How much of a card's deciding text an overview shows; the whole of it is on the card. */
export const ATTENTION_DECIDING_CHARS = 500;
const TITLE_CHARS = 120;
/** How much of an Assistant card's body an overview shows; the whole of it is on the card. */
export const ATTENTION_CARD_BODY_CHARS = 300;
const MAX_HOURS = 168;

export type AttentionGroup = "assistantCards" | "needsDecision" | "running" | "lostCards" | "stopped" | "finishedUnread" | "finishedRead";
const GROUPS: readonly AttentionGroup[] = ["assistantCards", "needsDecision", "running", "lostCards", "stopped", "finishedUnread", "finishedRead"];

export interface AttentionChat {
  sessionId: string;
  project: string | null;
  providerId: string | null;
  title: string | null;
}

export interface AttentionCard {
  requestId: string;
  kind: string;
  tool: string;
  headline: string;
  deciding: { facts: Array<{ label: string; value: string }>; label?: string; text: string; shortened: boolean; complete: boolean; incompleteReason?: string };
  questions?: NormalizedQuestion[];
}

/**
 * One of the PPM Assistant's cards that still waits on the user, as the Assistant window shows
 * it. It waits there (and on Telegram, when connected) until the user answers it.
 */
export interface AttentionAssistantCard {
  cardId: string;
  kind: AssistantCardKind;
  project: string | null;
  title: string;
  /** The card's text, shortened for an overview. */
  body?: string;
  bodyShortened?: boolean;
  /** The manager chat the card came from, when it came from one. */
  managerSessionId: string | null;
  createdAt: string;
  /** The card can be answered with one tap (the whole decision fits on it): its OK, or one of its `choices`. */
  okOffered: boolean;
  /** The card carries a draft message the manager wants to send. */
  hasDraft: boolean;
  /** The choices the card offers the user, one button each (labels shortened for an overview). */
  choices?: Array<{ id: string; label: string }>;
  /** An approval or question card mirrors this request of its manager chat (listed in needsDecision too). */
  requestId?: string;
}

export interface ChatsAttention {
  since: string;
  /** The Assistant's open cards, oldest first; not limited by `since`, since a card waits until answered. */
  assistantCards: AttentionAssistantCard[];
  needsDecision: Array<AttentionChat & { card: AttentionCard; queuedCards: number }>;
  running: Array<AttentionChat & { phase: string }>;
  lostCards: Array<AttentionChat & { kind: "approval" | "question" }>;
  stopped: Array<AttentionChat & { endedAt: string; error: string; subtype?: string; unread: boolean }>;
  finishedUnread: Array<AttentionChat & { endedAt?: string }>;
  finishedRead: Array<AttentionChat & { endedAt: string }>;
  /** How many more each group had than it shows. */
  more: Partial<Record<AttentionGroup, number>>;
  note?: string;
}

/** Where the overview reads from; replaced in tests. */
export interface AttentionSources {
  live(): Array<LiveChatState & { sessionId: string }>;
  unread(): UnreadEntry[];
  turnEnds(sinceMs: number): TurnEnd[];
  /** Project, provider and title as PPM records them, for chats only the trace named. */
  meta(sessionIds: string[]): Map<string, { project: string | null; providerId: string | null; title: string | null }>;
  isAssistant(sessionId: string): boolean;
  /** The Assistant's cards still waiting on the user; none when absent. */
  openCards?(): AssistantCard[];
}

function recordedMeta(ids: string[]): Map<string, { project: string | null; providerId: string | null; title: string | null }> {
  const out = new Map<string, { project: string | null; providerId: string | null; title: string | null }>();
  if (!ids.length) return out;
  const q = getDb().query(
    `SELECT m.project_name, m.provider_id, COALESCE(t.title, m.last_known_title) AS title
     FROM session_metadata m LEFT JOIN session_titles t ON t.session_id = m.session_id WHERE m.session_id = ?`,
  );
  for (const id of ids) {
    const r = q.get(id) as { project_name: string | null; provider_id: string | null; title: string | null } | null;
    // A title stored under the id a chat had before Codex renamed it is found by the watch's
    // lookup, so the overview names the chat as its relayed cards and reports do.
    out.set(id, { project: r?.project_name ?? null, providerId: r?.provider_id ?? null, title: r?.title ?? watchedChatTitle(id) });
  }
  return out;
}

export const defaultAttentionSources: AttentionSources = {
  live: () => chatControl()?.listLive() ?? [],
  unread: getAllUnread,
  turnEnds: (since) => turnEndsSince(since),
  meta: recordedMeta,
  isAssistant: (id) => isAssistantSession(id),
  openCards: () => cardStore.openCards(),
};

/**
 * The start of the window `since` names: "today" (local midnight, the default) or "<n>h" for the
 * last n hours (1–168).
 */
export function parseAttentionSince(raw: unknown, now = Date.now()): { ok: true; value: number } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "today") {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return { ok: true, value: midnight.getTime() };
  }
  const m = typeof raw === "string" ? /^(\d{1,3})h$/.exec(raw.trim()) : null;
  const hours = m ? Number(m[1]) : NaN;
  if (!(hours >= 1 && hours <= MAX_HOURS)) return { ok: false, error: `\`since\` is "today" or a number of hours like "6h" (1–${MAX_HOURS}).` };
  return { ok: true, value: now - hours * 3_600_000 };
}

function attentionCard(card: LiveApprovalCard): AttentionCard {
  const d = decidingInput(card);
  const shortened = d.text.length > ATTENTION_DECIDING_CHARS;
  return {
    requestId: card.requestId,
    kind: d.kind,
    tool: card.tool,
    headline: d.title,
    deciding: {
      facts: d.facts,
      ...(d.label ? { label: d.label } : {}),
      text: shortened ? `${d.text.slice(0, ATTENTION_DECIDING_CHARS)}…` : d.text,
      shortened,
      complete: d.complete,
      ...(d.incompleteReason ? { incompleteReason: d.incompleteReason } : {}),
    },
    ...(card.questions ? { questions: card.questions } : {}),
  };
}

function attentionAssistantCard(card: AssistantCard): AttentionAssistantCard {
  const whole = cleanSummaryText(card.body, Number.MAX_SAFE_INTEGER) ?? "";
  const shortened = whole.length > ATTENTION_CARD_BODY_CHARS;
  return {
    cardId: card.id,
    kind: card.kind,
    project: card.projectName,
    title: cleanSummaryText(card.title, TITLE_CHARS) || card.kind,
    ...(whole ? { body: cleanSummaryText(whole, ATTENTION_CARD_BODY_CHARS)! } : {}),
    ...(shortened ? { bodyShortened: true } : {}),
    managerSessionId: card.sessionId,
    createdAt: new Date(card.createdAt).toISOString(),
    okOffered: card.okOffered === true,
    hasDraft: !!card.payload.draft,
    ...(card.payload.options?.length
      ? { choices: card.payload.options.map((o) => ({ id: o.id, label: cleanSummaryText(o.label, TITLE_CHARS) || o.id })) }
      : {}),
    ...(card.payload.requestId ? { requestId: card.payload.requestId } : {}),
  };
}

export function chatsAttention(
  opts: { project?: string; since: number },
  sources: AttentionSources = defaultAttentionSources,
): ChatsAttention {
  const seen = new Set<string>();
  const notes: string[] = [];
  const groups: { [G in AttentionGroup]: ChatsAttention[G] } = {
    assistantCards: [], needsDecision: [], running: [], lostCards: [], stopped: [], finishedUnread: [], finishedRead: [],
  };

  try {
    for (const card of sources.openCards?.() ?? []) {
      if (opts.project && card.projectName !== opts.project) continue;
      groups.assistantCards.push(attentionAssistantCard(card));
    }
  } catch {
    notes.push("The Assistant's cards could not be read: cards waiting in the Assistant window are missing.");
  }

  // One chat, one group: the first (most urgent) to claim it keeps it. The Assistant's own chats
  // and other projects are never listed.
  const claim = (rawId: string, project: string | null): string | null => {
    const id = resolveMigratedSession(rawId);
    if (seen.has(id)) return null;
    if (isAssistantProject(project) || sources.isAssistant(id) || sources.isAssistant(rawId)) return null;
    if (opts.project && project !== opts.project) return null;
    seen.add(id);
    return id;
  };
  const title = (t: string | null | undefined): string | null => cleanSummaryText(t, TITLE_CHARS) || null;

  const live = sources.live();
  const unread = sources.unread();
  let ends: TurnEnd[] = [];
  try {
    ends = sources.turnEnds(opts.since);
  } catch {
    notes.push("The session trace could not be read: finished and stopped chats from it are missing.");
  }
  const unreadById = new Map(unread.map((u) => [resolveMigratedSession(u.sessionId), u]));
  const meta = sources.meta([...new Set([...live.map((l) => l.sessionId), ...ends.map((e) => e.sessionId), ...unreadById.keys()])]);
  const chat = (id: string, project: string | null, providerId: string | null): AttentionChat => {
    const m = meta.get(id);
    const u = unreadById.get(id);
    return { sessionId: id, project: project ?? m?.project ?? null, providerId: providerId ?? m?.providerId ?? null, title: title(m?.title ?? u?.sessionTitle) };
  };

  for (const l of live) {
    if (!l.card) continue;
    const id = claim(l.sessionId, l.projectName || null);
    if (id) groups.needsDecision.push({ ...chat(id, l.projectName || null, l.providerId), card: attentionCard(l.card), queuedCards: l.queuedCards });
  }
  for (const l of live) {
    if (!l.running) continue;
    const id = claim(l.sessionId, l.projectName || null);
    if (id) groups.running.push({ ...chat(id, l.projectName || null, l.providerId), phase: l.phase });
  }
  // A card nothing holds any more: the unread mark says one was waiting, and no live chat shows it.
  for (const u of unread) {
    if (u.unreadType !== "approval_request" && u.unreadType !== "question") continue;
    const id = claim(u.sessionId, u.projectName);
    if (id) groups.lostCards.push({ ...chat(id, u.projectName, null), kind: u.unreadType === "question" ? "question" : "approval" });
  }
  for (const e of ends) {
    if (!e.stop) continue;
    const m = meta.get(e.sessionId);
    const id = claim(e.sessionId, m?.project ?? null);
    if (id) {
      groups.stopped.push({
        ...chat(id, null, e.providerId), endedAt: new Date(e.endedAt).toISOString(), error: e.stop.message.slice(0, 300),
        ...(e.stop.subtype ? { subtype: e.stop.subtype } : {}), unread: unreadById.has(id),
      });
    }
  }
  const endedAt = new Map(ends.map((e) => [e.sessionId, e.endedAt]));
  for (const u of unread) {
    const id = claim(u.sessionId, u.projectName);
    if (!id) continue;
    const at = endedAt.get(id);
    groups.finishedUnread.push({ ...chat(id, u.projectName, null), ...(at ? { endedAt: new Date(at).toISOString() } : {}) });
  }
  for (const e of ends) {
    const m = meta.get(e.sessionId);
    const id = claim(e.sessionId, m?.project ?? null);
    if (id) groups.finishedRead.push({ ...chat(id, null, e.providerId), endedAt: new Date(e.endedAt).toISOString() });
  }

  const more: ChatsAttention["more"] = {};
  for (const g of GROUPS) {
    const list = groups[g] as unknown[];
    if (list.length > ATTENTION_GROUP_MAX) {
      more[g] = list.length - ATTENTION_GROUP_MAX;
      list.length = ATTENTION_GROUP_MAX;
    }
  }
  return {
    since: new Date(opts.since).toISOString(),
    ...groups,
    more,
    ...(notes.length ? { note: notes.join(" ") } : {}),
  };
}
