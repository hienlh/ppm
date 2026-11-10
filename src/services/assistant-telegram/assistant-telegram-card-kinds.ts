/**
 * What a PPM Assistant card says on Telegram, per kind and per project detail level, and which of
 * its buttons may be offered. Approval and question cards are not here: they go out as the relay's
 * own cards, with the Allow rule that comes with them.
 *
 * - `full`: the label, the server's provenance line, the title, the body and the quoted draft.
 * - `title`: the label, the project and the title only — no body, draft or diff, and no button
 *   that would act on what is not shown. Set per project for work whose details must not reach a
 *   phone (client or tax data).
 *
 * Every manager-written string is redacted, escaped and has its hidden characters made visible.
 * "OK, send" follows `cardOkOffered` (the whole decision shown, nothing hidden), and "Approve
 * change" the same bar on the rules diff, so neither ever stands for text the user did not see.
 */
import type { AssistantCard } from "../../shared/assistant-cards.ts";
import { escapeHiddenCharacters } from "../../shared/reveal-hidden-characters.ts";
import { escapeTelegramHtml, truncateText } from "../notification-format.ts";
import { redactSecretsForTelegram } from "../telegram/telegram-html-format.ts";
import { REVIEW_FIT_MAX, TOO_LONG_NOTE } from "./assistant-telegram-card-format.ts";

export type CardDetail = "full" | "title";
export type CardButtonOp = "ok" | "approve" | "revert";

export interface FormattedManagerCard {
  html: string;
  buttons: Array<{ text: string; op: CardButtonOp }>;
}

const PREVIEW_MAX = 1200;
const BODY_MAX = 1500;
export const REPLY_HINT = "Reply to this message to answer in your own words.";

const LOOK: Record<AssistantCard["kind"], { icon: string; label: string }> = {
  needs_decision: { icon: "🔔", label: "Needs your decision" },
  urgent: { icon: "⚠️", label: "Urgent" },
  approval: { icon: "🔐", label: "Needs your approval" },
  question: { icon: "❓", label: "Needs your answer" },
  done: { icon: "✅", label: "Done" },
  failed: { icon: "❌", label: "Failed" },
  digest: { icon: "☕", label: "Morning digest" },
  rules_note: { icon: "📝", label: "Rules updated" },
  rules_change: { icon: "📝", label: "Rules change waiting" },
  budget: { icon: "⏸", label: "Assistant paused messaging" },
};

/** Redacted, hidden characters shown, escaped; `hidden` counts what redaction took out. */
function clean(text: string, counter: { hidden: number }): string {
  const r = redactSecretsForTelegram(escapeHiddenCharacters(text));
  counter.hidden += r.hidden;
  return escapeTelegramHtml(r.text);
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

export function formatManagerCard(card: AssistantCard, detail: CardDetail): FormattedManagerCard {
  const look = LOOK[card.kind];
  const counter = { hidden: 0 };
  const project = card.projectName ? ` · ${clean(oneLine(card.projectName), counter)}` : "";
  const lines = [`${look.icon} <b>${look.label}</b>${project}`];
  if (card.provenance) lines.push(`<i>${escapeTelegramHtml(card.provenance)}</i>`);
  lines.push(`<b>${clean(oneLine(card.title), counter)}</b>`);
  const buttons: FormattedManagerCard["buttons"] = [];
  const full = detail === "full";

  if (full && card.body) lines.push(clean(truncateText(card.body, BODY_MAX), counter));
  if (card.kind === "needs_decision" || card.kind === "urgent") {
    const draft = card.payload.draft;
    if (full && draft) {
      const text = card.okOffered ? draft.text : `${draft.text.slice(0, PREVIEW_MAX).trimEnd()}\n…`;
      lines.push(`<b>To:</b> ${clean(oneLine(draft.to), counter)}`, `<pre>${clean(text, counter)}</pre>`);
      if (!card.okOffered) lines.push(`⚠️ ${escapeTelegramHtml(TOO_LONG_NOTE)}`);
    }
    if (card.payload.urgentCapped) lines.push("<i>Held for the morning: this manager already raised its urgent reports tonight.</i>");
    if (full && card.okOffered) buttons.push({ text: draft ? "OK, send" : "OK", op: "ok" });
    if (full) lines.push(`<i>${REPLY_HINT}</i>`);
  } else if (card.kind === "digest" && full) {
    for (const item of (card.payload.items ?? []).slice(0, 12)) lines.push(`• ${clean(oneLine(item), counter)}`);
  } else if (card.kind === "rules_note" && full) {
    const added = card.payload.added ?? [];
    if (added.length) lines.push(`<blockquote>${clean(added.join("\n"), counter)}</blockquote>`);
  } else if (card.kind === "rules_change") {
    const diff = [...(card.payload.removed ?? []).map((l) => `- ${l}`), ...(card.payload.added ?? []).map((l) => `+ ${l}`)].join("\n");
    const before = counter.hidden;
    const fits = diff.length <= REVIEW_FIT_MAX;
    if (full && diff) lines.push(`<pre>${clean(fits ? diff : `${diff.slice(0, PREVIEW_MAX)}\n…`, counter)}</pre>`);
    if (full && !fits) lines.push(`⚠️ ${escapeTelegramHtml(TOO_LONG_NOTE)}`);
    if (full && fits && counter.hidden === before && card.payload.rulesHash) buttons.push({ text: "Approve change", op: "approve" });
    if (card.payload.rulesHash) buttons.push({ text: "Revert", op: "revert" });
  }
  if (counter.hidden > 0) lines.push(`<i>🔒 ${counter.hidden} secret-looking value${counter.hidden === 1 ? "" : "s"} hidden.</i>`);
  return { html: lines.join("\n"), buttons };
}

/** The line under a card's Telegram copy once it no longer waits. */
export function cardEndLine(card: AssistantCard): string {
  const note = card.answer?.note;
  switch (card.status) {
    case "dismissed": return "<i>Dismissed.</i>";
    case "gone": return "<i>No longer waiting.</i>";
    default: return `<i>${escapeTelegramHtml(note ?? (card.status === "answered" ? "Answered." : "No longer waiting."))}</i>`;
  }
}
