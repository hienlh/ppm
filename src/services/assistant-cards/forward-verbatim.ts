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
import type { TaskReference } from "../../shared/chat-task-ref.ts";
import type { TaskFollowupContext } from "./task-words-followup.ts";
import type { SessionDelivery } from "../../shared/session-collab.ts";
import type { DeliverUserWordsInput, DeliverUserWordsResult } from "../../server/ws/chat-user-words.ts";
import type { FollowupHandle, FollowupOrigin } from "./card-reply-followup-tracker.ts";
import { writeReplyImages, type ReplyImage, type ValidReplyImage } from "./card-reply-images.ts";
import { unlinkSync } from "node:fs";

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
  /** The card's message in that Telegram chat the user replied to. */
  telegramReplyTo?: number;
  /** The user's own message in that chat (the reply itself). */
  telegramMessageId?: number;
}

export interface ForwardHow {
  actor: CardActor;
  ok?: boolean;
  /** The choice the user pressed on a card that offered several (never with `ok`). */
  choice?: { id: string; label: string };
  draftSha256?: string;
  draftTo?: string;
  /** The words answer the request the manager chat waits on (a reply to an approval or question card). */
  supersede: boolean;
  /** The manager's answer to these words goes back here once its turn ends (a reply, not an OK). */
  followUp?: FollowupOrigin;
  /** Images sent with a reply, already checked (`validateReplyImages`); written to disk only here. */
  images?: readonly ValidReplyImage[];
}

export interface ForwardEnv {
  now(): number;
  managerTarget(card: AssistantCard): ForwardTarget | null;
  deliverUserWords(input: DeliverUserWordsInput): Promise<DeliverUserWordsResult>;
  /**
   * An ordinary message from the user to the main Assistant session, typed on Telegram; `card` is
   * the card it replies to, quoted after the words.
   */
  sendToAssistant(text: string, card?: AssistantCard, images?: ReadonlyArray<{ data: string; mediaType: string }>): Promise<{ ok: true } | { ok: false; error: string }>;
  /** The user wrote to this chat: its pair counts start again. */
  userWrote(sessionId: string): void;
  mainSession(): string | null;
  note(assistantSessionId: string, line: string): void;
  trace(sessionId: string, providerId: string, payload: Record<string, unknown>): void;
  /** Starts following the turn that will answer words sent under `clientMessageId`. */
  expectFollowup?(input: { cardId: string; clientMessageId: string; origin: FollowupOrigin; sessionId: string }): FollowupHandle;
  /** Likewise for words about a task, whose answer goes back under the user's own message. */
  expectTaskFollowup?(input: { clientMessageId: string; sessionId: string; context: TaskFollowupContext }): FollowupHandle;
  /** Writes a reply's images where the manager chat can read them; PPM's uploads folder by default. */
  writeImages?(images: readonly ValidReplyImage[]): ReplyImage[];
  /** Removes images written for words that never went out; nothing refers to them. */
  discardImages?(paths: readonly string[]): void;
}

function discardWritten(env: ForwardEnv, written: readonly ReplyImage[]): void {
  if (!written.length) return;
  const paths = written.map((w) => w.path);
  if (env.discardImages) return env.discardImages(paths);
  for (const p of paths) {
    try { unlinkSync(p); } catch { /* already gone */ }
  }
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
    const images = how.images?.map(({ data, mediaType }) => ({ data, mediaType }));
    const sent = await env.sendToAssistant(`(My reply to the ${kindName(card)} card${project}.)\n\n${text}`, card, images?.length ? images : undefined);
    return sent.ok ? { ok: true, to: "assistant" } : sent;
  }
  const target = env.managerTarget(card);
  if (!target) return { ok: false, error: "The manager chat this card came from cannot be found any more." };
  const userWords: UserWordsReference = {
    cardId: card.id, channel: actor.channel, at: new Date(env.now()).toISOString(),
    ...(how.ok ? { ok: true as const } : {}),
    ...(how.ok && how.draftSha256 ? { draftSha256: how.draftSha256, ...(how.draftTo ? { draftTo: how.draftTo } : {}) } : {}),
    ...(!how.ok && how.choice ? { choice: how.choice } : {}),
  };
  // Written only now, with every check passed and the chat found: a reply that goes nowhere leaves
  // no file behind, and one whose send fails below has its files removed again.
  let written: ReplyImage[] = [];
  if (how.images?.length) {
    try {
      written = (env.writeImages ?? writeReplyImages)(how.images);
    } catch (e) {
      return { ok: false, error: `the images could not be saved (${(e as Error).message || "write failed"})` };
    }
  }
  // The id is chosen here, before the send, so the turn it opens can be followed even when the
  // provider names that turn before the send returns.
  const clientMessageId = `card-${crypto.randomUUID()}`;
  const following = how.followUp
    ? env.expectFollowup?.({ cardId: card.id, clientMessageId, origin: how.followUp, sessionId: target.sessionId }) ?? null
    : null;
  let delivered: DeliverUserWordsResult;
  try {
    delivered = await env.deliverUserWords({
      targetSessionId: target.sessionId, providerId: target.providerId, projectName: target.projectName,
      projectPath: target.projectPath, text, userWords, supersede: how.supersede, clientMessageId,
      ...(written.length ? { images: written } : {}),
    });
  } catch (e) {
    // A send that threw delivered nothing: a reply left followed would wait 12 hours for a turn.
    following?.abandon();
    discardWritten(env, written);
    throw e;
  }
  if (!delivered.ok) {
    following?.abandon();
    discardWritten(env, written);
    return delivered;
  }
  following?.attach(delivered.delivered);
  env.userWrote(delivered.sessionId);
  env.trace(delivered.sessionId, target.providerId, {
    cardId: card.id, channel: actor.channel, ok: how.ok === true,
    ...(how.choice ? { choice: how.choice.id } : {}),
    ...(written.length ? { imageCount: written.length } : {}),
    ...(actor.deviceId ? { deviceId: actor.deviceId } : {}),
    ...(actor.fetchSite ? { fetchSite: actor.fetchSite } : {}),
    ...(actor.telegramChatId ? { telegramChatId: actor.telegramChatId } : {}),
  });
  const main = env.mainSession();
  if (main) {
    const what = how.ok ? "gave their OK on" : how.choice ? `picked the choice with id "${how.choice.id}" on` : "answered";
    env.note(main, `The user ${what} the ${kindName(card)} card ${card.id} for ${target.projectName} ${where(actor.channel)}; `
      + `PPM forwarded it word for word to ${card.payload.chat ? "the chat it came from" : "that project's manager chat"}.`);
  }
  return {
    ok: true, to: "manager", projectName: target.projectName, sessionId: delivered.sessionId,
    delivered: delivered.delivered, clientMessageId: delivered.clientMessageId,
  };
}

/** The user's words about one task, sent to the chat working on it (Telegram's "Message about this task"). */
export interface TaskWordsInput {
  text: string;
  /** The chat working on the task: its handed-off chat, else the project's manager chat. */
  target: ForwardTarget;
  /** The task, as the store has it now (`resolveTaskRef`); written as the message's task block. */
  taskRef: TaskReference;
  actor: CardActor;
  /** Where the chat's answer goes back once the turn that reads the words ends (Telegram). */
  followUp?: TaskFollowupContext;
}

export type TaskWordsResult =
  | { ok: true; sessionId: string; delivered?: SessionDelivery }
  | { ok: false; error: string };

/**
 * Forwards what the user typed about a task, word for word, to the chat working on it. Like a card
 * reply it carries a user-words block (no card is named, the channel and time are), and after it
 * the task's block, so the chat knows which of its tasks the words are about. The words wait behind
 * any request the chat has open rather than answering it: the user wrote about the task, not to
 * that request.
 */
export async function forwardUserWordsAboutTask(input: TaskWordsInput, env: ForwardEnv): Promise<TaskWordsResult> {
  const { actor, target, taskRef } = input;
  const userWords: UserWordsReference = { channel: actor.channel, at: new Date(env.now()).toISOString() };
  // Chosen before the send, so the turn the words open can be followed even when the provider
  // names it before the send returns.
  const clientMessageId = `card-${crypto.randomUUID()}`;
  const following = input.followUp
    ? env.expectTaskFollowup?.({ clientMessageId, sessionId: target.sessionId, context: input.followUp }) ?? null
    : null;
  let delivered: DeliverUserWordsResult;
  try {
    delivered = await env.deliverUserWords({
      targetSessionId: target.sessionId, providerId: target.providerId, projectName: target.projectName,
      projectPath: target.projectPath, text: input.text, userWords, taskRefs: [taskRef], supersede: false, clientMessageId,
    });
  } catch (e) {
    following?.abandon();
    throw e;
  }
  if (!delivered.ok) {
    following?.abandon();
    return delivered;
  }
  following?.attach(delivered.delivered);
  env.userWrote(delivered.sessionId);
  env.trace(delivered.sessionId, target.providerId, {
    taskId: taskRef.taskId, channel: actor.channel,
    ...(actor.telegramChatId ? { telegramChatId: actor.telegramChatId } : {}),
    ...(actor.deviceId ? { deviceId: actor.deviceId } : {}),
  });
  const main = env.mainSession();
  if (main) {
    env.note(main, `The user wrote about task ${taskRef.ref} (${taskRef.taskId}) ${where(actor.channel)}; `
      + `PPM forwarded it word for word to the chat working on it in ${target.projectName}.`);
  }
  return { ok: true, sessionId: delivered.sessionId, delivered: delivered.delivered };
}
