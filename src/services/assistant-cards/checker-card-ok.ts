/**
 * The user's OK on a card the handed-off work checker raised ("N handed-off tasks need a look").
 * The checker posts such a card only when it could not wake the project's manager chat — the chat
 * was busy for a long while, or the wake budget was spent — so the OK means "tell the manager now":
 * the card's findings go to the manager as one wake the user asked for (`wakeManager` with the
 * user as actor). Asked by the user, that wake first restarts the project's wake count and lifts its
 * pause, exactly as "Tell manager now" in PPM or on Telegram does; and since the card exists only
 * because a wake could not go, this one goes even past the hourly and daily caps (`overBudgetOnce`).
 *
 * Forwarding a bare "OK" instead, as for a card a manager filed, told the manager nothing: it had
 * never seen the card, and the words named it by id only.
 *
 * The rest is what forwarding the user's words does, minus the Assistant's note: the wake goes out
 * under a `card-` client id, so an OK queued behind a running turn stays `pending` until a turn opens
 * with it and is opened again if none does (`card-delivery.ts`); the user pressing OK resets the
 * pair counts like any answer; and the session trace records who pressed it, where.
 */
import type { AssistantCard } from "../../shared/assistant-cards.ts";
import { checkerCardWakeLines } from "../ppm-tasks/child-check/child-check-findings.ts";
import { wakeManager, type DeliverOutcome } from "../ppm-tasks/ppm-tasks-deliver.ts";
import type { CardActor, ForwardEnv, ForwardResult } from "./forward-verbatim.ts";

export type WakeForCard = (projectKey: string, lines: string[], clientMessageId: string) => Promise<DeliverOutcome>;

/** What the OK needs besides the wake: the forward's own bookkeeping. */
export type CheckerCardOkEnv = Pick<ForwardEnv, "managerTarget" | "userWrote" | "trace">;

const liveWake: WakeForCard = (projectKey, lines, clientMessageId) =>
  wakeManager(projectKey, { kind: "user", label: "You" }, lines, { overBudgetOnce: true, clientMessageId });

const REFUSED: Record<Exclude<DeliverOutcome, { ok: true }>["reason"], string> = {
  no_session: "this project has no manager chat any more",
  budget: "PPM has sent this project's manager its most wakes for the hour or the day",
  busy: "the manager chat is busy",
  no_chat: "no chat layer runs in this process",
  nothing: "there was nothing to send",
  not_found: "the task is gone",
  no_option: "the task has no such option",
  error: "the send failed",
};

export async function wakeManagerForCheckerCard(
  card: AssistantCard, actor: CardActor, env: CheckerCardOkEnv, wake: WakeForCard = liveWake,
): Promise<ForwardResult> {
  if (!card.projectKey) return { ok: false, error: "This card names no project" };
  const clientMessageId = `card-${crypto.randomUUID()}`;
  const outcome = await wake(card.projectKey, checkerCardWakeLines(card, actor.channel), clientMessageId);
  if (!outcome.ok) return { ok: false, error: outcome.error ? `${REFUSED[outcome.reason]} (${outcome.error})` : REFUSED[outcome.reason] };
  env.userWrote(outcome.sessionId);
  env.trace(outcome.sessionId, env.managerTarget(card)?.providerId ?? "claude", {
    cardId: card.id, channel: actor.channel, ok: true, wake: true,
    ...(actor.deviceId ? { deviceId: actor.deviceId } : {}),
    ...(actor.fetchSite ? { fetchSite: actor.fetchSite } : {}),
    ...(actor.telegramChatId ? { telegramChatId: actor.telegramChatId } : {}),
  });
  return {
    ok: true, to: "manager", projectName: card.projectName ?? "", sessionId: outcome.sessionId, delivered: outcome.delivered, clientMessageId,
  };
}
