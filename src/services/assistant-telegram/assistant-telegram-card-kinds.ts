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
 * The body is Markdown, as the manager writes it: it goes through the same formatter as the chat's
 * answers (`markdownToTelegramHtml`, which escapes before it adds a tag). The draft stays verbatim
 * in a `<pre>`: it is what would be sent, character for character.
 * "OK, send" follows `cardOkOffered` (the whole decision shown, nothing hidden), and so do the
 * buttons of a card that offers choices (one per choice, numbered as the text lists them);
 * "Approve change" meets the same bar on the rules diff. None ever stands for text the user did not see.
 */
import { cardWithdrawal, type AssistantCard, type CardFile, type CardOption } from "../../shared/assistant-cards.ts";
import { TELEGRAM_UPLOAD_MAX_BYTES, cardFileAppPath, formatFileSize } from "../../shared/card-files.ts";
import {
  DIGEST_NO_ANSWER, DIGEST_NOTHING_NEW, DIGEST_RESURFACED_HEADING, DIGEST_VOICE_LEARNED_HINT, digestVoiceLearnedHeading,
  digestWaitingSummary, type DigestProject, type DigestResurfacedTask, type DigestVoiceLearned,
} from "../../shared/assistant-digest.ts";
import { escapeHiddenCharacters } from "../../shared/reveal-hidden-characters.ts";
import { escapeTelegramHtml, truncateText } from "../notification-format.ts";
import { markdownToTelegramHtml, redactSecretsForTelegram, splitTelegramHtml } from "../telegram/telegram-html-format.ts";
import { REVIEW_FIT_MAX, TOO_LONG_NOTE } from "./assistant-telegram-card-format.ts";

export type CardDetail = "full" | "title";
export type CardButtonOp = "ok" | "choose" | "approve" | "revert";

export interface FormattedManagerCard {
  html: string;
  /** `optionId` names the choice a `choose` button stands for. */
  buttons: Array<{ text: string; op: CardButtonOp; optionId?: string }>;
}

const PREVIEW_MAX = 1200;
const BODY_MAX = 1500;
/** Said on a card whose choices cannot be pressed here (too long, or a part was hidden). */
export const CHOICES_IN_PPM_NOTE = "Too long to choose from with a button, or a part was hidden — reply with your choice in your own words.";
const RULES_IN_PPM_NOTE = "Not the whole change, or too long to review here — open the rules in PPM (Settings → Assistant) to approve it.";
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

/** The icon a card of this kind leads with, as its line on the pinned card desk shows it too. */
export const cardIcon = (kind: AssistantCard["kind"]): string => LOOK[kind]?.icon ?? "🔔";

/** Redacted, hidden characters shown, escaped; `hidden` counts what redaction took out. */
function clean(text: string, counter: { hidden: number }): string {
  const r = redactSecretsForTelegram(escapeHiddenCharacters(text));
  counter.hidden += r.hidden;
  return escapeTelegramHtml(r.text);
}

/** The same treatment for any other manager-written line bound for Telegram. */
export const cleanTelegramText = clean;

/**
 * A card's body as Telegram HTML. Cut as shown (hidden characters revealed first) before it is
 * formatted, so the cut lands in the Markdown and the formatter closes every tag it opens. A
 * table is padded to its widest cells, so formatting can make the text much longer than the
 * Markdown: past `BODY_MAX` as Telegram counts it, the HTML is cut again, between tags.
 */
function bodyHtml(text: string, counter: { hidden: number }): string {
  const r = redactSecretsForTelegram(truncateText(escapeHiddenCharacters(text), BODY_MAX));
  counter.hidden += r.hidden;
  const html = markdownToTelegramHtml(r.text);
  return telegramVisibleLength(html) <= BODY_MAX ? html : `${splitTelegramHtml(html, BODY_MAX)[0] ?? ""}\n…`;
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * The start of a text too long to show whole, measured as it will be shown: hidden characters are
 * revealed first (each grows to `⟨U+XXXX⟩`), so a preview can never outgrow its room.
 */
function preview(text: string): string {
  const shown = escapeHiddenCharacters(text);
  return shown.length > PREVIEW_MAX ? `${shown.slice(0, PREVIEW_MAX).trimEnd()}\n…` : shown;
}

/** Room for the digest's sections under Telegram's 4096, leaving the head and the link. */
const DIGEST_TELEGRAM_MAX = 3200;

/**
 * A digest section's waiting tasks, PPM's own list: "⏳ 3 tasks waiting, 1 on you", then one line
 * each ("✋ <code>ppm/12</code> Title — <b>Waiting on you</b> · Due today"). A project whose details
 * stay off the phone shows the count line only.
 */
function digestWaitingLines(p: DigestProject, counter: { hidden: number }, countOnly = false): string[] {
  if (!p.waiting?.length) return [];
  if (countOnly && !p.titleOnly) return [`<i>⏳ ${digestWaitingSummary(p)}; the list is on the card in PPM.</i>`];
  const head = `<i>⏳ ${digestWaitingSummary(p)}${p.titleOnly ? "; the details stay in PPM." : ":"}</i>`;
  if (p.titleOnly) return [head];
  const lines = p.waiting.map((w) => {
    const label = w.mine ? `<b>${clean(oneLine(w.label), counter)}</b>` : clean(oneLine(w.label), counter);
    const until = w.until ? ` · ${clean(oneLine(w.until), counter)}` : "";
    return `${w.mine ? "✋" : "•"} <code>${clean(oneLine(w.ref), counter)}</code> ${clean(truncateText(oneLine(w.title), 80), counter)} — ${label}${until}`;
  });
  if (p.waitingMore) lines.push(`<i>…and ${p.waitingMore} more in PPM.</i>`);
  return [head, ...lines];
}

/**
 * The digest's sections: a project's numbered items, or why there are none. A project whose
 * details stay off the phone shows only how many items it has. Past the room left, the rest is
 * said to be in PPM rather than cut mid-item.
 */
/** Monday's voice section: the words learned this week, to know about rather than to answer. */
function digestVoiceLines(words: readonly DigestVoiceLearned[], counter: { hidden: number }): string[] {
  if (!words.length) return [];
  const shown = words.slice(0, 20).map((w) => `${clean(oneLine(w.word), counter)} (${clean(oneLine(w.from), counter)})`).join(" · ");
  const more = words.length > 20 ? ` <i>…and ${words.length - 20} more in PPM.</i>` : "";
  return [`\n<b>🎙 ${digestVoiceLearnedHeading(words.length)}</b>`, `${shown}${more}`, `<i>${DIGEST_VOICE_LEARNED_HINT}</i>`];
}

function digestLines(
  projects: readonly DigestProject[], counter: { hidden: number }, resurfaced: readonly DigestResurfacedTask[] = [],
  voiceLearned: readonly DigestVoiceLearned[] = [],
): string[] {
  const out: string[] = [];
  let used = 0;
  // PPM's own section first: short, and what the user put out of mind until today.
  if (resurfaced.length) {
    const section = [`
<b>💤 ${DIGEST_RESURFACED_HEADING}</b>`];
    for (const t of resurfaced.slice(0, 12)) section.push(`• <code>${clean(oneLine(t.ref), counter)}</code> ${clean(oneLine(t.title).slice(0, 120), counter)}`);
    if (resurfaced.length > 12) section.push(`<i>…and ${resurfaced.length - 12} more in PPM.</i>`);
    out.push(...section);
    used += section.reduce((n, l) => n + l.length + 1, 0);
  }
  for (const p of projects) {
    const section = [`\n<b>${clean(oneLine(p.name), counter)}</b>`];
    if (p.state === "no_answer") section.push(`<i>${DIGEST_NO_ANSWER}</i>`);
    else if (p.items.length === 0) section.push(`<i>${DIGEST_NOTHING_NEW}</i>`);
    else if (p.titleOnly) section.push(`<i>${p.items.length} item${p.items.length === 1 ? "" : "s"}; the details stay in PPM for this project.</i>`);
    else p.items.slice(0, 12).forEach((item, i) => section.push(`${i + 1}. ${clean(oneLine(item), counter)}`));
    const sizeOf = (lines: string[]) => lines.reduce((n, l) => n + l.length + 1, 0);
    // The waiting list is what a section gives up when it would not fit; its count stays.
    let lines = [...section, ...digestWaitingLines(p, counter)];
    if (used + sizeOf(lines) > DIGEST_TELEGRAM_MAX) lines = [...section, ...digestWaitingLines(p, { hidden: 0 }, true)];
    const size = sizeOf(lines);
    if (used + size > DIGEST_TELEGRAM_MAX) {
      out.push("\n<i>The rest is on the card in PPM.</i>");
      break;
    }
    used += size;
    out.push(...lines);
  }
  const voice = digestVoiceLines(voiceLearned, counter);
  const voiceSize = voice.reduce((n, l) => n + l.length + 1, 0);
  // Past the budget the section shrinks to its count, rather than the digest being refused for length.
  if (voice.length && used + voiceSize > DIGEST_TELEGRAM_MAX) {
    out.push(`\n<b>🎙 ${digestVoiceLearnedHeading(voiceLearned.length)}</b> <i>— the list is on the card in PPM.</i>`);
  } else {
    out.push(...voice);
  }
  return out;
}

/**
 * Most a card's own text may take as Telegram counts it (after parsing: tags gone, an entity is
 * one character), leaving room under its 4096 for the link and the line a finished card gets.
 */
export const TELEGRAM_CARD_ROOM = 3800;

/** The length Telegram counts for `html`: what is left once tags are parsed and entities read. */
export function telegramVisibleLength(html: string): number {
  return html.replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, "x").length;
}

/** The parts of a card the Telegram copy is built from. */
export type CardForTelegram = Pick<AssistantCard, "kind" | "projectName" | "provenance" | "title" | "body" | "payload" | "okOffered">
  & Partial<Pick<AssistantCard, "status" | "answer">>
  & {
    /** PPM's address for a link from the phone (`notificationLink`); each file then links to its viewer. */
    fileLinkBase?: string | null;
  };

/**
 * How long each choice's description may be, tried in turn when a card with choices would not fit
 * in one message. 0 leaves the label alone. A label and its button are never cut: the label is the
 * button's own text, and the description only says what pressing it does.
 */
const DESCRIPTION_CAPS = [200, 120, 60, 0] as const;
/** Said under choices whose descriptions were cut to fit. */
export const DESCRIPTIONS_CUT_NOTE = "Some descriptions are cut to fit Telegram; the whole text is on the card in PPM.";

/**
 * A card's Telegram copy. A card with choices that would not fit in one message has its choices'
 * descriptions cut, keeping every label and button. Any other decision shown whole that would not
 * fit is sent as the preview instead, without the button that stood for the whole of it.
 */
export function formatManagerCard(card: CardForTelegram, detail: CardDetail): FormattedManagerCard {
  const whole = renderCard(card, detail, true);
  const decides = whole.buttons.some((b) => b.op !== "revert");
  if (!decides || telegramVisibleLength(whole.html) <= TELEGRAM_CARD_ROOM) return whole;
  if (whole.buttons.some((b) => b.op === "choose")) {
    for (const cap of DESCRIPTION_CAPS) {
      const cut = renderCard(card, detail, true, cap);
      if (telegramVisibleLength(cut.html) <= TELEGRAM_CARD_ROOM) return cut;
    }
  }
  return renderCard({ ...card, okOffered: false }, detail, false);
}

/**
 * The files the card carries, as its text lists them: one line each, name and size, linked to the
 * PPM page that plays the original (`/card-file/<id>`: no size limit, nothing compressed, seekable),
 * and for one over the Bot API's 50 MB limit what happens to its Telegram copy. The files
 * themselves follow the card as replies to it (`assistant-telegram-card-files.ts`).
 */
function fileLines(files: readonly CardFile[], counter: { hidden: number }, base: string | null): string[] {
  const lines = files.map((f) => {
    const label = clean(oneLine(f.name), counter);
    const name = base
      ? `<a href="${escapeTelegramHtml(`${base.replace(/\/+$/, "")}${cardFileAppPath(f.id)}`)}">${label}</a> · ${formatFileSize(f.size)}`
      : `${label} · ${formatFileSize(f.size)}`;
    if (f.size <= TELEGRAM_UPLOAD_MAX_BYTES) return `📎 ${name}`;
    return f.kind === "video"
      ? `📎 ${name} <i>(over Telegram's 50 MB limit: a compressed copy follows if PPM can make one; the original is in PPM)</i>`
      : `📎 ${name} <i>(over Telegram's 50 MB limit: open it in PPM)</i>`;
  });
  const count = files.length === 1 ? "1 file" : `${files.length} files`;
  const head = base ? `${count}: tap a name to watch the original in PPM. Copies follow this card.` : `${count} follow this card.`;
  return [`<i>${head}</i>`, ...lines];
}

/**
 * The choices as the card's text lists them, right under its body: one line per choice, "N. label"
 * in bold as its button says it, then what it does. `cap` cuts each description to that length.
 */
function choiceLines(options: readonly CardOption[], counter: { hidden: number }, cap?: number): string[] {
  let cut = false;
  const lines = options.map((o, i) => {
    const label = `<b>${i + 1}. ${clean(oneLine(o.label), counter)}</b>`;
    if (!o.description) return label;
    const whole = oneLine(o.description);
    if (cap === undefined || whole.length <= cap) return `${label}: ${clean(whole, counter)}`;
    cut = true;
    return cap === 0 ? label : `${label}: ${clean(truncateText(whole, cap), counter)}`;
  });
  if (cut) lines.push(`<i>${escapeTelegramHtml(DESCRIPTIONS_CUT_NOTE)}</i>`);
  return lines;
}

function renderCard(card: CardForTelegram, detail: CardDetail, offerWhole: boolean, descriptionCap?: number): FormattedManagerCard {
  const look = LOOK[card.kind];
  const counter = { hidden: 0 };
  const project = card.projectName ? ` · ${clean(oneLine(card.projectName), counter)}` : "";
  const lines = [`${look.icon} <b>${look.label}</b>${project}`];
  if (card.provenance) lines.push(`<i>${escapeTelegramHtml(card.provenance)}</i>`);
  lines.push(`<b>${clean(oneLine(card.title), counter)}</b>`);
  const buttons: FormattedManagerCard["buttons"] = [];
  const full = detail === "full";

  if (full && card.body) lines.push(bodyHtml(card.body, counter));
  const decision = card.kind === "needs_decision" || card.kind === "urgent";
  const options = decision ? card.payload.options ?? [] : [];
  // Right under the body, so they are read with it rather than found under everything else: a
  // button holds a short label, the text says what each one does.
  if (full && options.length) lines.push("", ...choiceLines(options, counter, descriptionCap));
  const pictures = card.payload.images?.length ?? 0;
  if (full && pictures) lines.push(`<i>🖼 ${pictures} picture${pictures === 1 ? "" : "s"} above, numbered as listed.</i>`);
  if (full && card.payload.files?.length) lines.push(...fileLines(card.payload.files, counter, card.fileLinkBase ?? null));
  if (decision) {
    const draft = card.payload.draft;
    if (full && draft) {
      const text = card.okOffered ? draft.text : preview(draft.text);
      lines.push(`<b>To:</b> ${clean(oneLine(draft.to), counter)}`, `<pre>${clean(text, counter)}</pre>`);
      if (!card.okOffered) lines.push(`⚠️ ${escapeTelegramHtml(TOO_LONG_NOTE)}`);
    }
    if (full && options.length) {
      if (card.okOffered) {
        options.forEach((o, i) => buttons.push({ text: `${i + 1}. ${escapeHiddenCharacters(oneLine(o.label))}`, op: "choose", optionId: o.id }));
      } else {
        lines.push(`⚠️ ${escapeTelegramHtml(CHOICES_IN_PPM_NOTE)}`);
      }
    }
    if (card.payload.urgentCapped) lines.push("<i>Held for the morning: this manager already raised its urgent reports tonight.</i>");
    if (full && card.okOffered && !options.length) buttons.push({ text: draft ? "OK, send" : "OK", op: "ok" });
    if (full) lines.push(`<i>${REPLY_HINT}</i>`);
  } else if (card.kind === "digest" && full) {
    if (card.payload.projects) lines.push(...digestLines(card.payload.projects, counter, card.payload.resurfaced, card.payload.voiceLearned));
    else for (const item of (card.payload.items ?? []).slice(0, 12)) lines.push(`• ${clean(oneLine(item), counter)}`);
  } else if (card.kind === "rules_note" && full) {
    const added = card.payload.added ?? [];
    if (added.length) lines.push(`<blockquote>${clean(added.join("\n"), counter)}</blockquote>`);
  } else if (card.kind === "rules_change") {
    // In file order, removals as removals: the same change Settings shows.
    const diff = (card.payload.changes ?? []).map((c) => `${c.op === "remove" ? "-" : "+"} ${c.line}`).join("\n");
    const before = counter.hidden;
    const whole = offerWhole && card.payload.rulesComplete === true && diff.length <= REVIEW_FIT_MAX;
    if (full && diff) lines.push(`<pre>${clean(whole ? diff : preview(diff), counter)}</pre>`);
    if (full && !whole) lines.push(`⚠️ ${escapeTelegramHtml(RULES_IN_PPM_NOTE)}`);
    if (full && whole && counter.hidden === before && card.payload.rulesHash) buttons.push({ text: "Approve change", op: "approve" });
    if (card.payload.rulesHash) buttons.push({ text: "Revert", op: "revert" });
  }
  if (counter.hidden > 0) lines.push(`<i>🔒 ${counter.hidden} secret-looking value${counter.hidden === 1 ? "" : "s"} hidden.</i>`);
  // PPM's own words: why a card that was answered waits again.
  if (card.status === "open" && card.answer?.note) lines.push(`⚠️ <i>${escapeTelegramHtml(card.answer.note)}</i>`);
  return { html: lines.join("\n"), buttons };
}

/** The line under a card's Telegram copy once it no longer waits. */
export function cardEndLine(card: AssistantCard): string {
  const note = card.answer?.note;
  const withdrawn = cardWithdrawal(card);
  if (withdrawn?.supersededBy) return `↪️ <i>Replaced by: ${escapeTelegramHtml(withdrawn.supersededBy.title)}</i>`;
  if (withdrawn) return `<i>Withdrawn by ${card.answer?.by === "assistant" ? "the Assistant" : "the manager"}: ${escapeTelegramHtml(withdrawn.reason)}</i>`;
  switch (card.status) {
    case "dismissed": return note && card.answer?.by === "ppm" ? `<i>${escapeTelegramHtml(note)}.</i>` : "<i>Dismissed.</i>";
    case "gone": return "<i>No longer waiting.</i>";
    default: return `<i>${escapeTelegramHtml(note ?? (card.status === "answered" ? "Answered." : "No longer waiting."))}</i>`;
  }
}
