/**
 * What a PPM task looks like on Telegram: the `/tasks` deck card, the card after a status press,
 * the open children, and the card for a task the Assistant created from a Telegram message. Pure:
 * it takes the task's facts as plain strings and returns HTML, so the wording is tested apart from
 * the bot.
 *
 * Every string a person or an AI wrote goes through `cleanTelegramText` (hidden characters shown,
 * secrets redacted, then escaped) before a tag is added around it. A project whose details stay
 * off the phone (`telegram_detail: title`) shows its title, project and urgency only.
 */
import type { Importance, Urgency } from "../../shared/ppm-tasks.ts";
import { dueText, waitingUntilText, type WaitingDetail } from "../../shared/ppm-tasks-waiting.ts";

export { dueText };
import { escapeTelegramHtml, truncateText } from "../notification-format.ts";
import { isPublicHttpsUrl } from "./assistant-telegram-links.ts";
import { cleanTelegramText, telegramVisibleLength, TELEGRAM_CARD_ROOM, type CardDetail } from "./assistant-telegram-card-kinds.ts";

export const URGENCY_LABEL: Record<Urgency, string> = { now: "Now", today: "Today", week: "This week", later: "Later" };
export const IMPORTANCE_LABEL: Record<Importance, string> = { must: "Must", should: "Should", nice: "Nice to have" };
const TYPE_LABEL: Record<string, string> = { task: "Task", decision: "Decision", reply: "Reply" };
export const typeLabel = (type: string): string => TYPE_LABEL[type] ?? type.charAt(0).toUpperCase() + type.slice(1);

const TITLE_MAX = 200;
const LINE_MAX = 300;
const LINKS_SHOWN = 3;
const CHILDREN_SHOWN = 10;

/** A link line, worded ("NX-6318 In Progress"), with the address its text opens when it has one. */
export type TaskCardLinkLine = string | { text: string; href: string | null };

/** One task's facts as the card shows them; the caller looks names up, the card only words them. */
export interface TaskCardFacts {
  /** `ppm/12`. */
  ref: string;
  projectName: string;
  title: string;
  type: string;
  statusName: string;
  closed: boolean;
  urgency: Urgency;
  /** True when the due date raised `urgency` above the stored one. */
  urgencyRaised: boolean;
  importance: Importance;
  /** `YYYY-MM-DD`. */
  dueDate: string | null;
  assignee: string | null;
  /** On whom the task waits and until when; null when it does not wait. */
  waiting: WaitingDetail | null;
  nextStep: string | null;
  /** Live states of its Jira and PR links, already worded ("NX-6318 In Progress"). */
  linkLines: TaskCardLinkLine[];
}

export interface CardContext {
  detail: CardDetail;
  /** The user's date (`YYYY-MM-DD`), for "Due tomorrow". */
  today: string;
  now: number;
}

const clean = (text: string, counter: { hidden: number }, max = LINE_MAX): string =>
  cleanTelegramText(truncateText(text.replace(/\s+/g, " ").trim(), max), counter);

/**
 * The waiting line: "✋ <b>Waiting on you</b> · Due today", "⏳ Waiting on Việt · for 2 days",
 * "⏳ Waiting · for 5 hours". A wait on the user is bold and marked with a raised hand.
 */
export function waitingLineHtml(w: WaitingDetail, ctx: Pick<CardContext, "today" | "now">, counter: { hidden: number }): string {
  const words = clean(w.label, counter, 120);
  const head = w.mine ? `✋ <b>${words}</b>` : `⏳ ${words}`;
  const until = waitingUntilText(w.until, ctx.today, ctx.now);
  return until ? `${head} · ${until}` : head;
}

/** The line a hidden-secret count adds, when redaction took anything out. */
const hiddenLine = (counter: { hidden: number }): string[] =>
  counter.hidden > 0 ? [`<i>🔒 ${counter.hidden} secret-looking value${counter.hidden === 1 ? "" : "s"} hidden.</i>`] : [];

/** Drops lines from the end (keeping the first two) until the card fits one Telegram message. */
function fit(lines: string[]): string {
  const out = [...lines];
  while (out.length > 2 && telegramVisibleLength(out.join("\n")) > TELEGRAM_CARD_ROOM) out.splice(out.length - 1, 1);
  return out.join("\n");
}

/**
 * A link line, as a tapable link when its address is public https — the only kind Telegram is sure
 * to take, as for buttons; a self-hosted Jira on an intranet name or plain http stays plain text.
 */
function linkLineHtml(link: TaskCardLinkLine, counter: { hidden: number }): string {
  const { text, href } = typeof link === "string" ? { text: link, href: null } : link;
  const shown = clean(text, counter);
  return href && isPublicHttpsUrl(href) ? `<a href="${escapeTelegramHtml(new URL(href).href)}">${shown}</a>` : shown;
}

/**
 * The task's code and title as one line: `<code>ppm/12</code> <b>Title</b>`. Telegram sets the code
 * in monospace and copies it on a tap, so the code the chats use is one tap from the clipboard.
 */
function codeTitleHtml(ref: string, titleHtml: string, counter: { hidden: number }): string {
  return `<code>${clean(ref, counter, 60)}</code> ${titleHtml}`;
}

/** The task's facts, without the header line: what the deck card and the created card share. */
function factLines(f: TaskCardFacts, ctx: CardContext, counter: { hidden: number }, opts: { withStatus: boolean }): string[] {
  const project = clean(f.projectName, counter, 100);
  const urgency = `<b>${URGENCY_LABEL[f.urgency]}</b>${f.urgencyRaised ? " (due date)" : ""}`;
  const lines = [codeTitleHtml(f.ref, `<b>${clean(f.title, counter, TITLE_MAX)}</b>`, counter)];
  if (ctx.detail === "title") {
    lines.push(`${project} · ${urgency}`);
    return lines;
  }
  const head = [f.type !== "task" ? typeLabel(f.type) : null, project, urgency, IMPORTANCE_LABEL[f.importance], opts.withStatus ? clean(f.statusName, counter, 60) : null];
  lines.push(head.filter(Boolean).join(" · "));
  // A waiting task's due date is on its waiting line, as its "until when".
  const dueShown = f.waiting?.until?.kind === "due";
  const when = [f.dueDate && !dueShown ? dueText(f.dueDate, ctx.today) : null, f.assignee ? clean(f.assignee, counter, 80) : null].filter(Boolean);
  if (when.length) lines.push(when.join(" · "));
  if (f.waiting) lines.push(waitingLineHtml(f.waiting, ctx, counter));
  for (const link of f.linkLines.slice(0, LINKS_SHOWN)) lines.push(linkLineHtml(link, counter));
  if (f.nextStep) lines.push(`<i>Next: ${clean(f.nextStep, counter)}</i>`);
  return lines;
}

/** The `/tasks` card: "1 of 14 · What to do first", then the task. `note` goes above it (PPM's own words). */
export function deckCardHtml(f: TaskCardFacts, pos: { index: number; total: number }, ctx: CardContext, note?: string, snoozed = 0): string {
  const counter = { hidden: 0 };
  const lines = [
    ...(note ? [`⚠️ <i>${clean(note, counter)}</i>`] : []),
    `<i>${pos.index + 1} of ${pos.total} · What to do first</i>`,
    ...factLines(f, ctx, counter, { withStatus: true }),
    ...hiddenLine(counter),
    ...snoozedLine(snoozed),
  ];
  return fit(lines);
}

/** "💤 2 snoozed": tasks left out of the deck until their day or a link change; none, no line. */
export function snoozedLine(snoozed: number): string[] {
  return snoozed > 0 ? [`💤 <i>${snoozed} snoozed — hidden until their day or a link change; see them in PPM.</i>`] : [];
}

export interface StatusChange {
  from: string;
  to: string;
  /** "14:02" in the user's time zone. */
  at: string;
  openChildren: number;
  /** PPM's own line on what the manager was told, once the user answered. */
  managerLine?: string;
}

/** The card after a status press: the title (struck through once closed) and what changed. */
export function statusResultHtml(f: TaskCardFacts, pos: { index: number; total: number }, change: StatusChange): string {
  const counter = { hidden: 0 };
  const title = clean(f.title, counter, TITLE_MAX);
  const children = change.openChildren > 0
    ? ` ${change.openChildren} child task${change.openChildren === 1 ? " is" : "s are"} still open.`
    : "";
  const lines = [
    `<i>${pos.index + 1} of ${pos.total} · What to do first</i>`,
    codeTitleHtml(f.ref, `<b>${f.closed ? `<s>${title}</s>` : title}</b>`, counter),
    `Status: ${clean(change.from, counter, 60)} → <b>${clean(change.to, counter, 60)}</b>`,
    `<i>By you from Telegram, ${change.at}.${children}</i>`,
    ...(change.managerLine ? [`<i>${clean(change.managerLine, counter)}</i>`] : []),
    ...hiddenLine(counter),
  ];
  return fit(lines);
}

/** The deck once it has nothing more to show. */
export function deckEmptyHtml(projectName: string | null, finished: boolean, snoozed = 0): string {
  const where = projectName ? ` in ${cleanTelegramText(projectName, { hidden: 0 })}` : "";
  const text = finished
    ? `✅ <b>That was the last one.</b>\nNo more open tasks${where} in this list. Send /tasks for a fresh one.`
    : `No open tasks${where}.`;
  return [text, ...snoozedLine(snoozed)].join("\n");
}

export interface ChildLine {
  ref: string;
  title: string;
  statusName: string;
}

/** The open children of a task, listed under its code and title. */
export function childrenHtml(parent: { ref: string | null; title: string }, children: readonly ChildLine[]): string {
  const counter = { hidden: 0 };
  const of = clean(parent.title, counter, TITLE_MAX);
  const lines = [`<b>Open child tasks of</b> ${parent.ref ? codeTitleHtml(parent.ref, `<b>${of}</b>`, counter) : `<b>${of}</b>`}`];
  for (const c of children.slice(0, CHILDREN_SHOWN)) {
    lines.push(`• ${codeTitleHtml(c.ref, clean(c.title, counter, 120), counter)} — ${clean(c.statusName, counter, 60)}`);
  }
  if (children.length > CHILDREN_SHOWN) lines.push(`<i>…and ${children.length - CHILDREN_SHOWN} more in PPM.</i>`);
  if (!children.length) lines.push("<i>None are open any more.</i>");
  return fit([...lines, ...hiddenLine(counter)]);
}

/** The card for a task the Assistant created from a Telegram message. */
export function createdCardHtml(f: TaskCardFacts, ctx: CardContext, extra: { managerLine: string | null; note?: string; undone?: boolean }): string {
  const counter = { hidden: 0 };
  const project = clean(f.projectName, counter, 100);
  if (extra.undone) {
    return fit([`<i>Created in ${project}</i>`, codeTitleHtml(f.ref, `<b><s>${clean(f.title, counter, TITLE_MAX)}</s></b>`, counter), "<i>Undone: the task was removed.</i>"]);
  }
  const facts = factLines(f, ctx, counter, { withStatus: false });
  if (ctx.detail === "full") {
    // "Task · This week · Should · Backlog": the type and its place, then the status.
    facts[1] = [typeLabel(f.type), `<b>${URGENCY_LABEL[f.urgency]}</b>`, IMPORTANCE_LABEL[f.importance], clean(f.statusName, counter, 60)].join(" · ");
  }
  const lines = [
    ...(extra.note ? [`⚠️ <i>${clean(extra.note, counter)}</i>`] : []),
    `<i>Created in ${project}</i>`,
    ...facts,
    ...(extra.managerLine ? [`<i>${clean(extra.managerLine, counter)}</i>`] : []),
    ...hiddenLine(counter),
  ];
  return fit(lines);
}

export interface StatusChoice {
  id: string;
  name: string;
  baseGroup: string;
  closedAs: string | null;
}

/** Most status buttons a card offers. */
export const STATUS_BUTTONS_MAX = 6;

/**
 * The statuses a card offers as buttons: the project's own, in its order, without the current one,
 * at most six, with "closed as done" last (where a thumb ends up after reading the card).
 */
export function statusChoices<T extends StatusChoice>(statuses: readonly T[], currentId: string): T[] {
  const others = statuses.filter((s) => s.id !== currentId);
  const done = others.filter((s) => s.baseGroup === "closed" && s.closedAs === "done");
  const rest = others.filter((s) => !done.includes(s));
  const room = STATUS_BUTTONS_MAX - Math.min(done.length, 1);
  return [...rest.slice(0, room), ...done.slice(0, 1)];
}

/** Items laid out `perRow` to a row. */
export function inRows<T>(items: readonly T[], perRow: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += perRow) rows.push(items.slice(i, i + perRow));
  return rows;
}
