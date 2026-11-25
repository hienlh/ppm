/**
 * A card's author taking it back: a manager chat whose newer card replaces an old one, or that
 * the user told the matter was handled elsewhere; or the PPM Assistant, for a card the user asked
 * it to clear. PPM never closes a card that waits on the user on its own — only the card's author
 * or the user does — and a withdrawal is undone by the user's Restore.
 *
 * What may be withdrawn, checked here and never left to the model:
 * - only an open card, compare-and-set, so an answer the user gave a moment earlier wins;
 * - only a manager's own reports (`WITHDRAWABLE_CARD_KINDS`): never a chat's approval or question
 *   mirror (it ends with its request), a rules change or a budget pause;
 * - never a card opened again because the user's answer did not reach the manager (an open card
 *   carrying an answer): withdrawing it would lose that answer;
 * - a manager: the cards of its own project — its own, or a previous manager chat's of that project
 *   — never a card the PPM Assistant wrote;
 * - the PPM Assistant: any such card in a turn the user started, only its own cards otherwise;
 * - at most `WITHDRAW_PER_TURN` cards per turn of the withdrawing chat. Past it the chat asks the
 *   user on a card, whose OK opens a new turn.
 */
import { createLogger } from "../logger.ts";
import { resolveMigratedSession } from "../db.service.ts";
import { WITHDRAWABLE_CARD_KINDS, type AssistantCard, type CardWithdrawal } from "../../shared/assistant-cards.ts";
import { WITHDRAW_CARDS_MAX } from "../../shared/card-withdraw.ts";
import { WITHDRAW_FALLBACK_WINDOW_MS, WITHDRAW_PER_TURN, WITHDRAW_REASON_MAX } from "../../shared/assistant-limits.ts";
import { cleanCardBody } from "./card-text-cleaning.ts";
import type { AssistantCards, TransitionResult } from "./assistant-cards.service.ts";
import type { CardRow } from "./assistant-cards-db.ts";

const log = createLogger("assistant-cards");

/** Who withdraws: a project's manager chat, or the PPM Assistant (in a turn the user started, or not). */
export type WithdrawActor =
  | { kind: "manager"; sessionId: string; projectKey: string }
  | { kind: "assistant"; sessionId: string; userTurn: boolean };

export type WithdrawOutcome = "withdrawn" | "not_found" | "ambiguous" | "not_open" | "not_yours" | "kind" | "answer_pending" | "limit";

export interface WithdrawItem {
  /** The id as the caller gave it. */
  ref: string;
  /** The card it named, when it named one. */
  card?: { id: string; title: string; kind: string };
  outcome: WithdrawOutcome;
}

export interface WithdrawEnv {
  cards: Pick<AssistantCards, "transition" | "toCard">;
  now(): number;
  row(id: string): CardRow | null;
  /** Open cards whose id starts with `prefix` (at least eight characters). */
  openWithPrefix(prefix: string): CardRow[];
  /** The turn the chat is in now, when PPM knows it. */
  turnOf(sessionId: string): string | null;
  /** Cards this chat withdrew in `turnId`, or since `since` when the turn is not known. */
  withdrawnCount(sessionId: string, turnId: string | null, since: number): number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX_RE = /^[0-9a-f-]{8,36}$/i;

/** Whether `actor` may withdraw `row` (its status aside). */
export function ownsCard(actor: WithdrawActor, row: CardRow): boolean {
  if (actor.kind === "assistant") return actor.userTurn || row.payload.byAssistant === true;
  // A manager: its project's own reports, the previous manager chat's included, never the Assistant's.
  return row.projectKey === actor.projectKey && row.sessionId !== null && row.payload.byAssistant !== true;
}

/** Finds the card a ref names: a whole id, or a prefix of at least eight characters naming one open card. */
function findCard(env: WithdrawEnv, ref: string): { row: CardRow } | { outcome: "not_found" | "ambiguous" } {
  const id = ref.trim();
  if (UUID_RE.test(id)) {
    const row = env.row(id.toLowerCase()) ?? env.row(id);
    return row ? { row } : { outcome: "not_found" };
  }
  if (!PREFIX_RE.test(id)) return { outcome: "not_found" };
  const matches = env.openWithPrefix(id.toLowerCase());
  if (matches.length === 1) return { row: matches[0]! };
  return { outcome: matches.length === 0 ? "not_found" : "ambiguous" };
}

/** Checks a reason: required, cleaned like a card's body, capped. */
export function withdrawReason(raw: unknown): { ok: true; reason: string } | { ok: false; message: string } {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, message: "`reason` is required: say in a few words why the card is no longer needed." };
  if (raw.length > WITHDRAW_REASON_MAX) return { ok: false, message: `\`reason\` is at most ${WITHDRAW_REASON_MAX} characters.` };
  const reason = cleanCardBody(raw, WITHDRAW_REASON_MAX);
  return reason ? { ok: true, reason } : { ok: false, message: "`reason` must say something." };
}

/** Checks a list of card refs: 1 to `WITHDRAW_CARDS_MAX` strings, duplicates dropped. */
export function withdrawRefs(raw: unknown, field = "cards"): { ok: true; refs: string[] } | { ok: false; message: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > WITHDRAW_CARDS_MAX || !raw.every((r) => typeof r === "string" && r.trim() && r.length <= 64)) {
    return { ok: false, message: `\`${field}\` is a list of 1 to ${WITHDRAW_CARDS_MAX} card ids.` };
  }
  return { ok: true, refs: [...new Set((raw as string[]).map((r) => r.trim()))] };
}

/**
 * Withdraws each card `refs` names, as far as the rules above allow; one result per ref. A card
 * that replaces them (`supersededBy`) is named on each, so every surface can point to it.
 */
export function withdrawCards(
  env: WithdrawEnv, actor: WithdrawActor, refs: readonly string[], reason: string,
  supersededBy?: { id: string; title: string },
  /** Only say what would happen: nothing changes. A report uses it to name what its new card replaces. */
  dryRun = false,
): WithdrawItem[] {
  const self = resolveMigratedSession(actor.sessionId);
  const turnId = env.turnOf(self);
  let used = env.withdrawnCount(self, turnId, env.now() - WITHDRAW_FALLBACK_WINDOW_MS);
  const results: WithdrawItem[] = [];
  for (const ref of refs) {
    const found = findCard(env, ref);
    if ("outcome" in found) { results.push({ ref, outcome: found.outcome }); continue; }
    const row = found.row;
    const card = { id: row.id, title: row.title, kind: row.kind };
    const fail = (outcome: WithdrawOutcome) => results.push({ ref, card, outcome });
    if (supersededBy && row.id === supersededBy.id) continue;
    if (!WITHDRAWABLE_CARD_KINDS.includes(row.kind)) { fail("kind"); continue; }
    if (!ownsCard(actor, row)) { fail("not_yours"); continue; }
    if (row.status !== "open") { fail("not_open"); continue; }
    if (row.answer) { fail("answer_pending"); continue; }
    if (used >= WITHDRAW_PER_TURN) { fail("limit"); continue; }
    if (dryRun) { used++; results.push({ ref, card, outcome: "withdrawn" }); continue; }
    const withdrawn: CardWithdrawal = { sessionId: self, reason, ...(supersededBy ? { supersededBy } : {}), ...(turnId ? { turnId } : {}) };
    const moved = env.cards.transition(row.id, "dismissed", {
      by: actor.kind, channel: "chat", at: env.now(),
      note: supersededBy ? `Replaced by "${supersededBy.title}"` : `Withdrawn: ${reason}`,
      withdrawn,
    });
    if (!moved.ok) { fail("not_open"); continue; }
    used++;
    log.info(`card ${row.id} withdrawn by ${actor.kind} session ${self}${supersededBy ? ` (replaced by ${supersededBy.id})` : ""}`);
    results.push({ ref, card, outcome: "withdrawn" });
  }
  return results;
}

const OUTCOME_TEXT: Record<Exclude<WithdrawOutcome, "withdrawn">, string> = {
  not_found: "no such card",
  ambiguous: "that prefix names more than one open card; give the whole id",
  not_open: "it no longer waits (answered, dismissed or already withdrawn)",
  not_yours: "it is not one of this chat's cards",
  kind: "only needs_decision, urgent, done and failed reports can be withdrawn; a chat's approval or question card ends with its request",
  answer_pending: "the user's answer on it has not reached you yet; it stays",
  limit: `${WITHDRAW_PER_TURN} cards were already withdrawn in this turn. File one needs_decision card listing the rest and asking the user; their OK starts a new turn in which you can withdraw them`,
};

/** One line per result, for the tool's answer. */
export function describeWithdrawals(items: readonly WithdrawItem[]): string {
  return items.map((i) => {
    const name = i.card ? `${i.card.id} "${i.card.title.slice(0, 80)}"` : i.ref.slice(0, 64);
    return i.outcome === "withdrawn" ? `- ${name}: withdrawn.` : `- ${name}: not withdrawn — ${OUTCOME_TEXT[i.outcome]}.`;
  }).join("\n");
}

/** The cards a chat may withdraw that still wait, oldest first, as the tool lists them. */
export function describeOpenCards(cards: readonly AssistantCard[], now: number, limit = 10): string {
  if (cards.length === 0) return "No cards of yours are still open.";
  const lines = cards.slice(0, limit).map((c) => `- ${c.id} [${c.kind}] "${c.title.slice(0, 100)}" (${ageText(now - c.createdAt)} old)`);
  const more = cards.length > limit ? `\n…and ${cards.length - limit} more.` : "";
  return `${lines.join("\n")}${more}`;
}

function ageText(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

/** The user bringing back a withdrawn card. */
export function restoreWithdrawnCard(cards: Pick<AssistantCards, "restore">, id: string): TransitionResult {
  return cards.restore(id);
}
