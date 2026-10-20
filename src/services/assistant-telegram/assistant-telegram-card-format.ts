/**
 * What an approval or question card says on Telegram, and whether it may carry Allow.
 *
 * Allow is a promise that the person saw what they allowed. So it is offered only when the
 * card's whole deciding part (`decidingInput`: the full command, the content a write puts down,
 * every edit, the whole message an Assistant card sends) is complete and fits in the message,
 * escaped but otherwise unchanged. Whether it fits is measured on the text as it will run, not on
 * what is left once secrets are hidden: hiding a long value must not turn a card too long to
 * review into one that offers Allow. Anything that does not fit is shown as a preview marked
 * "Too long to review here", with only Deny and Open in PPM.
 *
 * Secrets are hidden first and the card says how many, and anything hidden takes Allow away: a
 * secret rule matches by shape, so what it hid may be more than the secret — a second command
 * after `cookie: a=1 &&`, a subquery in an MCP tool's SQL — and the person cannot see what Allow
 * would run. Such a card gets Deny and Open in PPM, where the request is shown in full.
 */
import { decidingInput, type DecidingInput } from "../chat-control/approval-deciding-input.ts";
import type { LiveApprovalCard } from "../chat-control/chat-control.ts";
import type { NormalizedQuestion } from "../../shared/approval-questions.ts";
import { escapeTelegramHtml } from "../notification-format.ts";
import { redactSecretsForTelegram } from "../telegram/telegram-html-format.ts";

/** The most the deciding part may take, in visible characters, for Allow to be offered. */
export const REVIEW_FIT_MAX = 3500;
/** How much of a part that does not fit is still shown, as a preview. */
const PREVIEW_MAX = 1200;

export const TOO_LONG_NOTE = "Too long to review here — open it in PPM to decide.";
export const HIDDEN_NOTE = "Part of this was hidden as a secret, so it cannot be allowed here — open it in PPM to decide.";

/**
 * Deciding parts where a hidden span changes nothing that runs: a question's choices are read,
 * not executed. Listed as the exceptions rather than the dangerous kinds, because almost any
 * other card (an MCP tool's arguments, a prompt an Assistant card sends) can carry code or
 * instructions that a span hidden by shape would cut into.
 */
const HIDING_IS_HARMLESS = new Set<DecidingInput["kind"]>(["question"]);

export interface FormattedCard {
  html: string;
  /** Allow may be offered: the whole deciding part is in `html`. */
  allow: boolean;
}

const esc = escapeTelegramHtml;

/** The deciding part of a card, redacted, as plain strings. */
function redacted(d: DecidingInput): { title: string; facts: Array<{ label: string; value: string }>; text: string; label: string; hidden: number } {
  let hidden = 0;
  const r = (s: string) => { const out = redactSecretsForTelegram(s); hidden += out.hidden; return out.text; };
  const title = r(d.title);
  const facts = d.facts.map((f) => ({ label: f.label, value: r(f.value) }));
  const text = r(d.text);
  // The body's heading is PPM's own wording ("Prompt", "Message"), never user data, so nothing to hide.
  return { title, facts, text, label: d.label ?? "", hidden };
}

function codeBlock(text: string, lang: DecidingInput["lang"]): string {
  if (!text) return "";
  return lang && lang !== "text" ? `<pre><code class="language-${lang}">${esc(text)}</code></pre>` : `<pre>${esc(text)}</pre>`;
}

/** The visible length Telegram counts for the deciding part. */
function decidingLength(p: Pick<DecidingInput, "title" | "facts" | "text"> & { label?: string }): number {
  return p.title.length + p.facts.reduce((n, f) => n + f.label.length + f.value.length + 3, 0) + (p.label ?? "").length + p.text.length;
}

export function formatApprovalCard(card: LiveApprovalCard, headline: string): FormattedCard {
  const d = decidingInput(card);
  const p = redacted(d);
  // Both: the text as it runs is what has to be reviewable, and the text as shown (a short secret
  // grows into `[REDACTED]`) is what has to fit in the message.
  const fits = decidingLength(d) <= REVIEW_FIT_MAX && decidingLength(p) <= REVIEW_FIT_MAX;
  const hiddenBlocksAllow = p.hidden > 0 && !HIDING_IS_HARMLESS.has(d.kind);
  const lines = [`🔐 <b>${esc(headline)}</b>`, `<b>${esc(p.title)}</b>`];
  for (const f of p.facts) lines.push(`<b>${esc(f.label)}:</b> ${esc(f.value)}`);
  const body = fits ? p.text : `${p.text.slice(0, PREVIEW_MAX).trimEnd()}\n…`;
  if (body) {
    // Without its heading the verbatim block (a schedule's prompt, the newest commit a push sends)
    // reads as one more line of the facts above it.
    if (p.label) lines.push(`<b>${esc(p.label)}:</b>`);
    lines.push(codeBlock(body, d.lang));
  }
  if (p.hidden > 0) lines.push(`<i>🔒 ${p.hidden} secret-looking value${p.hidden === 1 ? "" : "s"} hidden.</i>`);
  if (!d.complete) lines.push(`⚠️ ${esc(d.incompleteReason ?? "Only part of this request reached PPM.")}`);
  else if (!fits) lines.push(`⚠️ ${esc(TOO_LONG_NOTE)}`);
  else if (hiddenBlocksAllow) lines.push(`⚠️ ${esc(HIDDEN_NOTE)}`);
  return { html: lines.join("\n"), allow: d.complete && fits && !hiddenBlocksAllow };
}

/** A question that cannot be answered with buttons in a chat: a secret, or one with no choices. */
export function needsPpm(q: NormalizedQuestion): boolean {
  return q.secret === true || q.options.length === 0;
}

export function formatQuestionCard(questions: readonly NormalizedQuestion[], headline: string): string {
  const lines = [`❓ <b>${esc(headline)}</b>`];
  for (const q of questions) {
    const red = (s: string) => esc(redactSecretsForTelegram(s).text);
    lines.push("", `${q.header ? `<b>${red(q.header)}</b> — ` : ""}${red(q.question)}${q.multiSelect ? " <i>(choose any)</i>" : ""}`);
    for (const o of q.options) lines.push(`• ${red(o.label)}${o.description ? ` — <i>${red(o.description)}</i>` : ""}`);
    if (needsPpm(q)) lines.push(`<i>${q.secret ? "This answer is private: give it in PPM." : "This needs a typed answer: give it in PPM."}</i>`);
  }
  return lines.join("\n");
}

const REASONS: Record<string, string> = {
  turn_started: "a new turn started",
  turn_ended: "the turn ended",
  superseded_by_message: "a new message was sent instead",
  ws_cancel: "the turn was stopped",
  session_closed: "the chat was closed",
  // An Assistant request withdrawn or timed out: nobody answered it, so it was not "denied".
  request_ended: "the request ended without an answer",
};

/** The line under a card once it is no longer waiting. */
export function resolutionLine(r: { approved: boolean; reason: string; by?: string; answers?: unknown }, isQuestion: boolean): string {
  if (r.reason !== "answered") return `<i>No longer waiting: ${esc(REASONS[r.reason] ?? r.reason.replace(/_/g, " "))}.</i>`;
  const where = r.by === "telegram" ? "here" : r.by === "assistant" ? "by the Assistant" : "in PPM";
  if (isQuestion) {
    if (!r.approved) return `<i>Skipped ${where}.</i>`;
    const answers = r.answers && typeof r.answers === "object" ? Object.values(r.answers as Record<string, unknown>).map(String) : [];
    const shown = answers.length ? `: ${esc(redactSecretsForTelegram(answers.join("; ")).text.slice(0, 500))}` : "";
    return `<i>Answered ${where}${shown}</i>`;
  }
  return r.approved ? `✅ <i>Allowed ${where}.</i>` : `❌ <i>Denied ${where}.</i>`;
}
