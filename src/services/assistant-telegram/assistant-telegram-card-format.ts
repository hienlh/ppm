/**
 * What an approval or question card says on Telegram, and whether it may carry Allow.
 *
 * Allow is a promise that the person saw what they allowed. So it is offered only when the
 * card's whole deciding part (`decidingInput`: the full command, the content a write puts down,
 * every edit, the whole message an Assistant card sends) is complete and fits in the message,
 * escaped but otherwise unchanged. Secrets are hidden first and the card says how many — hiding a
 * key does not change what the command does. Anything that does not fit is shown as a preview
 * marked "Too long to review here", with only Deny and Open in PPM.
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

export interface FormattedCard {
  html: string;
  /** Allow may be offered: the whole deciding part is in `html`. */
  allow: boolean;
}

const esc = escapeTelegramHtml;

/** The deciding part of a card, redacted, as plain strings. */
function redacted(d: DecidingInput): { title: string; facts: Array<{ label: string; value: string }>; text: string; hidden: number } {
  let hidden = 0;
  const r = (s: string) => { const out = redactSecretsForTelegram(s); hidden += out.hidden; return out.text; };
  const title = r(d.title);
  const facts = d.facts.map((f) => ({ label: f.label, value: r(f.value) }));
  const text = r(d.text);
  return { title, facts, text, hidden };
}

function codeBlock(text: string, lang: DecidingInput["lang"]): string {
  if (!text) return "";
  return lang && lang !== "text" ? `<pre><code class="language-${lang}">${esc(text)}</code></pre>` : `<pre>${esc(text)}</pre>`;
}

/** The visible length Telegram counts for the deciding part: what `fits` is measured on. */
function decidingLength(p: ReturnType<typeof redacted>): number {
  return p.title.length + p.facts.reduce((n, f) => n + f.label.length + f.value.length + 3, 0) + p.text.length;
}

export function formatApprovalCard(card: LiveApprovalCard, headline: string): FormattedCard {
  const d = decidingInput(card);
  const p = redacted(d);
  const fits = decidingLength(p) <= REVIEW_FIT_MAX;
  const lines = [`🔐 <b>${esc(headline)}</b>`, `<b>${esc(p.title)}</b>`];
  for (const f of p.facts) lines.push(`<b>${esc(f.label)}:</b> ${esc(f.value)}`);
  const body = fits ? p.text : `${p.text.slice(0, PREVIEW_MAX).trimEnd()}\n…`;
  if (body) lines.push(codeBlock(body, d.lang));
  if (p.hidden > 0) lines.push(`<i>🔒 ${p.hidden} secret-looking value${p.hidden === 1 ? "" : "s"} hidden.</i>`);
  if (!d.complete) lines.push(`⚠️ ${esc(d.incompleteReason ?? "Only part of this request reached PPM.")}`);
  else if (!fits) lines.push(`⚠️ ${esc(TOO_LONG_NOTE)}`);
  return { html: lines.join("\n"), allow: d.complete && fits };
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
