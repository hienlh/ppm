/**
 * The user's own words, from a reply to one of the PPM Assistant's cards or their OK on its draft,
 * forwarded word for word to the card's manager chat. This is the only place that builds a
 * user-words block (`src/shared/user-words-block.ts`): the block names the card by id and carries
 * what PPM checked (the channel, the time, the draft's hash for an OK), never the card's title.
 *
 * Forwarding is the user writing: the pair counts between the manager and every other chat start
 * again, the main Assistant session hears about it on its next turn (no turn is started for it),
 * and the session trace records which device or Telegram chat sent it.
 *
 * A card that belongs to no manager chat (a digest, a rules or budget card) has nobody to forward
 * to: a Telegram reply to one goes to the Assistant as an ordinary message instead.
 */
import { MANAGER_REPLY_CARD_KINDS, type AssistantCard } from "../../shared/assistant-cards.ts";
import type { UserWordsReference } from "../../shared/user-words-block.ts";
import type { SessionDelivery } from "../../shared/session-collab.ts";
import type { DeliverUserWordsInput, DeliverUserWordsResult } from "../../server/ws/chat-user-words.ts";

export interface ForwardTarget {
  sessionId: string;
  providerId: string;
  projectName: string;
  projectPath: string;
}

/** Who sent the words, for the trace: a device in PPM or a Telegram chat. */
export interface CardActor {
  channel: "ppm" | "telegram";
  deviceId?: string;
  fetchSite?: string;
  telegramChatId?: string;
}

export interface ForwardHow {
  actor: CardActor;
  ok?: boolean;
  draftSha256?: string;
  draftTo?: string;
  /** The words answer the request the manager chat waits on (a reply to an approval or question card). */
  supersede: boolean;
}

export interface ForwardEnv {
  now(): number;
  managerTarget(card: AssistantCard): ForwardTarget | null;
  deliverUserWords(input: DeliverUserWordsInput): Promise<DeliverUserWordsResult>;
  /** An ordinary message from the user to the main Assistant session, typed on Telegram. */
  sendToAssistant(text: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** The user wrote to this chat: its pair counts start again. */
  userWrote(sessionId: string): void;
  mainSession(): string | null;
  note(assistantSessionId: string, line: string): void;
  trace(sessionId: string, providerId: string, payload: Record<string, unknown>): void;
}

export type ForwardResult =
  /**
   * `delivered` is how the words went in (`queued`: behind the running turn, and only in that
   * process's memory until the next turn opens with them, under `clientMessageId`).
   */
  | { ok: true; to: "manager"; projectName: string; sessionId: string; delivered?: SessionDelivery; clientMessageId?: string }
  | { ok: true; to: "assistant" }
  | { ok: false; error: string };

const KIND_NAMES: Record<AssistantCard["kind"], string> = {
  needs_decision: "needs-decision", urgent: "urgent", approval: "approval", question: "question", done: "done",
  failed: "failed", digest: "morning digest", rules_note: "rules", rules_change: "rules change", budget: "messaging pause",
};

export const kindName = (card: Pick<AssistantCard, "kind">): string => KIND_NAMES[card.kind];
const where = (channel: CardActor["channel"]): string => (channel === "telegram" ? "on Telegram" : "in PPM");

/** Whether a reply to this card goes to a manager chat rather than to the Assistant. */
export function repliesToManager(card: Pick<AssistantCard, "kind" | "sessionId">): boolean {
  return MANAGER_REPLY_CARD_KINDS.includes(card.kind) && !!card.sessionId;
}

export async function forwardUserWords(card: AssistantCard, text: string, how: ForwardHow, env: ForwardEnv): Promise<ForwardResult> {
  const { actor } = how;
  if (!repliesToManager(card)) {
    if (actor.channel !== "telegram") return { ok: false, error: "This card has no manager chat: write to the Assistant instead." };
    const project = card.projectName ? ` for ${card.projectName}` : "";
    const sent = await env.sendToAssistant(`(My reply to the ${kindName(card)} card${project}.)\n\n${text}`);
    return sent.ok ? { ok: true, to: "assistant" } : sent;
  }
  const target = env.managerTarget(card);
  if (!target) return { ok: false, error: "The manager chat this card came from cannot be found any more." };
  const userWords: UserWordsReference = {
    cardId: card.id, channel: actor.channel, at: new Date(env.now()).toISOString(),
    ...(how.ok ? { ok: true as const } : {}),
    ...(how.ok && how.draftSha256 ? { draftSha256: how.draftSha256, ...(how.draftTo ? { draftTo: how.draftTo } : {}) } : {}),
  };
  const delivered = await env.deliverUserWords({
    targetSessionId: target.sessionId, providerId: target.providerId, projectName: target.projectName,
    projectPath: target.projectPath, text, userWords, supersede: how.supersede,
  });
  if (!delivered.ok) return delivered;
  env.userWrote(delivered.sessionId);
  env.trace(delivered.sessionId, target.providerId, {
    cardId: card.id, channel: actor.channel, ok: how.ok === true,
    ...(actor.deviceId ? { deviceId: actor.deviceId } : {}),
    ...(actor.fetchSite ? { fetchSite: actor.fetchSite } : {}),
    ...(actor.telegramChatId ? { telegramChatId: actor.telegramChatId } : {}),
  });
  const main = env.mainSession();
  if (main) {
    const what = how.ok ? "gave their OK on" : "answered";
    env.note(main, `The user ${what} the ${kindName(card)} card ${card.id} for ${target.projectName} ${where(actor.channel)}; `
      + "PPM forwarded it word for word to that project's manager chat.");
  }
  return {
    ok: true, to: "manager", projectName: target.projectName, sessionId: delivered.sessionId,
    delivered: delivered.delivered, clientMessageId: delivered.clientMessageId,
  };
}
