/**
 * The answer to words the user sent a task's chat from Telegram ("💬 Message about this task", or a
 * reply to a task card), sent back to Telegram under the user's own message.
 *
 * The bot used to say only "✅ Sent to the chat …"; the chat answered in PPM, and on the phone that
 * looked like nothing happened. The words go in under a `card-…` client id, so the same tracker that
 * follows a card reply's turn follows theirs (`card-reply-followup-tracker.ts`, a second instance):
 * it binds to the turn that read these words — not the next turn to end, and never a later one — and
 * hands over that turn's final top-level text once it ends. Unlike a card reply, the phone is never
 * left without a word:
 *
 * - the turn stops at a card (an approval, a question, or one only PPM's screen can take), or the
 *   words were queued behind a card already showing: said once, while it waits;
 * - the turn was stopped, or ended on an error: said, with the error;
 * - the turn ended without writing anything, or the tracker could not tell which turn answered
 *   (another one ran first): said, with the chat's link, rather than nothing.
 *
 * Everything here runs on the chat lifecycle's hot path, so it only updates memory and hands the
 * result to the sink (the Telegram bridge), which must not block.
 */
import { createLogger } from "../logger.ts";
import { chatLifecycle } from "../chat-control/chat-lifecycle.ts";
import { chatControl } from "../chat-control/chat-control.ts";
import { resolveMigratedSession } from "../db.service.ts";
import { assistantClock } from "../assistant-wake/assistant-clock.ts";
import { turnSecretScrubber } from "../vault/turn-secret-scrubber.ts";
import type { TaskReference } from "../../shared/chat-task-ref.ts";
import { assistantCards } from "./assistant-cards.service.ts";
import { followupOutcome } from "./card-reply-followup.ts";
import {
  createFollowupTracker, type AnsweredReply, type FollowupHandle, type FollowupOrigin, type FollowupResult, type FollowupTrackerDeps,
} from "./card-reply-followup-tracker.ts";

const log = createLogger("assistant-cards");

/** Which chat the words went to, as the bot names it (`chatLabelHtml` in the Telegram bridge). */
export interface TaskChatLabel {
  kind: "manager" | "child";
  /** The handed-off chat's title; null for the manager or when it has none. */
  chatTitle: string | null;
  /** The detail level when the words were sent; the bridge reads it again before it sends. */
  detail: "full" | "title";
  /** The task's project, by key: whose detail level the bridge reads. */
  projectKey: string;
  projectName: string;
  providerId: string;
}

/** What the answer goes back with: where the user wrote, the task, and the chat. */
export interface TaskFollowupContext {
  origin: Extract<FollowupOrigin, { channel: "telegram" }> & { messageId: number };
  taskRef: Pick<TaskReference, "taskId" | "ref" | "title">;
  chat: TaskChatLabel;
}

export type TaskWaitingFor = "approval" | "question" | "ppm";

type Base = { context: TaskFollowupContext; sessionId: string; repliedAt: number };
export type TaskFollowupDelivery =
  /** `text` is empty when the turn ended without writing anything. */
  | (Base & { kind: "answer"; text: string; overflow: boolean })
  /** The turn answered with cards the chat made (a manager's report): their titles only. */
  | (Base & { kind: "cards"; cards: Array<{ id: string; title: string }> })
  | (Base & { kind: "waiting"; waitingFor: TaskWaitingFor })
  | (Base & { kind: "stopped" })
  | (Base & { kind: "failed"; error: string })
  /** Another turn ran before PPM could tell which one answered: the answer is in the chat. */
  | (Base & { kind: "unclear" });

export interface TaskFollowupSink {
  send(delivery: TaskFollowupDelivery): void;
}

const MAX_FOLLOWED = 200;
const MAX_AGE_MS = 12 * 60 * 60_000;

interface Followed { context: TaskFollowupContext; at: number; told: boolean }

export interface TaskWordsFollowupDeps extends Omit<FollowupTrackerDeps, "deliver" | "deliverEmpty" | "onUnanswered"> {
  sink(): TaskFollowupSink | null;
  /** The card the chat is showing now, if any: words queued behind it wait on it. */
  cardShowing?(sessionId: string): TaskWaitingFor | null;
  /** Vault values the AI repeats are replaced before the answer leaves PPM. */
  scrub?(text: string): string;
}

export function createTaskWordsFollowups(deps: TaskWordsFollowupDeps) {
  /** Keyed by the client id the words went in under, which is also the tracker's key. */
  const followed = new Map<string, Followed>();
  const scrub = deps.scrub ?? ((t: string) => t);

  function handOn(delivery: TaskFollowupDelivery): void {
    try {
      deps.sink()?.send(delivery);
    } catch (e) {
      log.warn(`task ${delivery.context.taskRef.ref}: the chat's answer could not be handed on: ${(e as Error).message}`);
    }
  }

  function deliver(result: FollowupResult): void {
    const f = followed.get(result.cardId);
    followed.delete(result.cardId);
    if (!f) return;
    const base = { context: f.context, sessionId: result.sessionId, repliedAt: result.repliedAt };
    if (result.stopped) {
      handOn(result.error ? { ...base, kind: "failed", error: scrub(result.error) } : { ...base, kind: "stopped" });
      return;
    }
    if (result.newCards.length > 0 && !result.text.trim()) {
      handOn({ ...base, kind: "cards", cards: result.newCards.map((c) => ({ id: c.id, title: scrub(c.title) })) });
      return;
    }
    log.info(`task ${f.context.taskRef.ref}: the chat answered the user's Telegram message (${result.text.length} chars)`);
    handOn({ ...base, kind: "answer", text: scrub(result.text), overflow: result.overflow });
  }

  const tracker = createFollowupTracker({
    ...deps,
    deliver,
    deliverEmpty: true,
    onUnanswered: (reply) => {
      const f = followed.get(reply.cardId);
      followed.delete(reply.cardId);
      if (!f) return;
      log.info(`task ${f.context.taskRef.ref}: another turn ran before the chat's answer could be told apart; pointing at the chat`);
      handOn({ context: f.context, sessionId: reply.sessionId, repliedAt: reply.repliedAt, kind: "unclear" });
    },
  });

  function prune(): void {
    const now = deps.now();
    for (const [id, f] of followed) if (now - f.at > MAX_AGE_MS) followed.delete(id);
    while (followed.size > MAX_FOLLOWED) followed.delete(followed.keys().next().value!);
  }

  /** Says once that the words wait on a card. */
  function tellWaiting(f: Followed, sessionId: string, waitingFor: TaskWaitingFor): void {
    if (f.told) return;
    f.told = true;
    handOn({ kind: "waiting", context: f.context, sessionId: deps.canonical(sessionId), waitingFor, repliedAt: f.at });
  }

  return {
    /**
     * The words are about to go to `sessionId` under `clientMessageId`: follow the turn that reads
     * them. Registered before the send, as the card reply's is.
     */
    expect(input: { clientMessageId: string; sessionId: string; context: TaskFollowupContext }): FollowupHandle {
      prune();
      const f: Followed = { context: input.context, at: deps.now(), told: false };
      followed.set(input.clientMessageId, f);
      const handle = tracker.expect({ cardId: input.clientMessageId, clientMessageId: input.clientMessageId, origin: input.context.origin, sessionId: input.sessionId });
      return {
        attach: (delivered) => {
          handle.attach(delivered);
          // Queued behind a card that is already showing: its `approval_shown` came before the words.
          if (delivered === "queued") {
            const card = deps.cardShowing?.(deps.canonical(input.sessionId)) ?? null;
            if (card && followed.get(input.clientMessageId) === f) tellWaiting(f, input.sessionId, card);
          }
        },
        abandon: () => { followed.delete(input.clientMessageId); handle.abandon(); },
      };
    },

    onStream: tracker.onStream,

    onTurnEnded(sessionId: string, how: { outcome: "done" | "stopped" | "failed"; error?: string | null; turnStillRunning?: boolean }): void {
      tracker.onTurnEnded(sessionId, how);
    },

    /**
     * A card is now on the chat's screen. Words whose turn is the one running there wait on it: the
     * user is told once, so the phone does not go quiet while the turn holds.
     */
    onCardShown(sessionId: string, waitingFor: TaskWaitingFor): void {
      if (followed.size === 0) return;
      const answering = tracker.answering(sessionId);
      for (const f of followed.values()) {
        const theirs = answering.some((a) => a.origin.channel === "telegram" && a.origin.chatId === f.context.origin.chatId
          && a.origin.messageId === f.context.origin.messageId);
        if (theirs) tellWaiting(f, sessionId, waitingFor);
      }
    },

    /** The task words a turn of this chat is answering now (see the card tracker's `answering`). */
    answering(sessionId: string | null): AnsweredReply[] {
      return tracker.answering(sessionId);
    },

    onCardCreated: tracker.onCardCreated,
    onMigrated: tracker.onMigrated,
    size: (): number => followed.size,
    clear(): void {
      followed.clear();
      tracker.clear();
    },
  };
}

export type TaskWordsFollowups = ReturnType<typeof createTaskWordsFollowups>;

let sink: TaskFollowupSink | null = null;

/** The process-wide follower; its listeners are attached by {@link startTaskWordsFollowups}. */
export const taskWordsFollowups: TaskWordsFollowups = createTaskWordsFollowups({
  canonical: resolveMigratedSession,
  isIdle: (sessionId) => !(chatControl()?.liveState(sessionId)?.running ?? false),
  turnId: (sessionId) => chatControl()?.liveState(sessionId)?.turnId,
  now: () => assistantClock.now(),
  setTimer: (fn, ms) => assistantClock.setTimer(fn, ms),
  sink: () => sink,
  cardShowing: (sessionId) => {
    const card = chatControl()?.liveState(sessionId)?.card;
    return card ? (card.isQuestion ? "question" : "approval") : null;
  },
  scrub: (text) => turnSecretScrubber.scrub(text),
});

/** The Telegram bridge started: answers go to it. */
export function attachTaskFollowupSink(s: TaskFollowupSink): void {
  sink = s;
}

export function detachTaskFollowupSink(s?: TaskFollowupSink): void {
  if (!s || sink === s) sink = null;
}

/** Starts listening on the chat lifecycle; returns the stop. */
export function startTaskWordsFollowups(): () => void {
  const offs = [
    chatLifecycle.on("stream", (e) => taskWordsFollowups.onStream(e.sessionId, e.event)),
    chatLifecycle.on("turn_ended", (e) => taskWordsFollowups.onTurnEnded(e.sessionId, {
      outcome: followupOutcome(e),
      // A turn stopped on request has no error to report; one an error or a limit ended does.
      error: e.cancelledBy ? null : e.error ?? e.stop?.message ?? null,
      ...(e.turnStillRunning ? { turnStillRunning: true } : {}),
    })),
    chatLifecycle.on("migrated", (e) => taskWordsFollowups.onMigrated(e.oldSessionId, e.newSessionId)),
    chatLifecycle.on("approval_shown", (e) => taskWordsFollowups.onCardShown(e.sessionId, e.card.isQuestion ? "question" : "approval")),
    chatLifecycle.on("ppm_only_card_shown", (e) => taskWordsFollowups.onCardShown(e.sessionId, "ppm")),
    assistantCards.onChange((card, change) => { if (change === "created") taskWordsFollowups.onCardCreated(card); }),
  ];
  return () => {
    for (const off of offs) off();
    taskWordsFollowups.clear();
  };
}
