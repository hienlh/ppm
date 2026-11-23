import { createLogger } from "../logger.ts";
import { resolveMigratedSession } from "../db.service.ts";
import type { ChatLifecycle, ChatLifecycleEvents } from "../chat-control/chat-lifecycle.ts";
import { decidingInput } from "../chat-control/approval-deciding-input.ts";
import { normalizeClaudeQuestions } from "../../shared/approval-questions.ts";
import type { AssistantClock, Cancel } from "../assistant-wake/assistant-clock.ts";
import { describeTurnStop } from "../../shared/turn-stop.ts";
import { FAILED_CARD_GRACE_MS } from "../../shared/assistant-limits.ts";
import { REPORT_KINDS, type AssistantCardKind } from "../../shared/assistant-cards.ts";
import { cleanCardBody, cleanCardTitle } from "./card-text-cleaning.ts";
import type { AssistantCards } from "./assistant-cards.service.ts";
import type { CardRow } from "./assistant-cards-db.ts";
import type { LateReply } from "../assistant-wake/manager-wake-sources.ts";
import type { ChatCardRef } from "./ordinary-chat-cards.ts";

/**
 * What PPM itself sees in a manager chat, turned into cards and news — and the cards every other
 * chat of a project waits on (`ordinary-chat-cards.ts` says which), so none waits unseen. The
 * chats a manager opened are among them: the user answers their cards on the mirror, and a
 * manager's report about one is folded into it (`report_to_assistant` with `chat`).
 *
 * - An approval or question a chat shows becomes a card mirroring it; the request ending anywhere
 *   (answered in the chat, on Telegram, by the turn ending, by running out of time) resolves the
 *   card. A card that takes a password typed into PPM (`db_execute`, vault) is only named: the
 *   mirror says the chat waits and links to it, with nothing to press.
 * - A manager turn that failed becomes a `failed` card after a grace period, unless the manager
 *   reported in between. A turn the user stopped, or one cut short by a rate limit or an
 *   overloaded provider, is not a failure the user needs a card for.
 * - The end of a manager turn that took an Assistant message nothing waited for is a late reply:
 *   news for the Assistant, no card. When that turn also answered the user's reply on a card, its
 *   answer already went straight to the user (`card-reply-followup.ts`, or as the card it opened):
 *   the news says so, so the Assistant does not tell the user the same thing a second time — it is
 *   still told, since the turn may have answered its own message too.
 *
 * Lifecycle listeners only record and enqueue.
 */

export interface ManagerRef {
  projectName: string;
  projectPath: string;
  sessionId: string;
}

export interface ManagerSignalsDeps {
  lifecycle: ChatLifecycle;
  cards: AssistantCards;
  clock: AssistantClock;
  managerFor(sessionId: string): ManagerRef | null;
  /** A chat that is not a manager, when its waiting cards are mirrored; none when left out. */
  chatFor?(p: { sessionId: string; projectName: string; providerId: string }): ChatCardRef | null;
  /**
   * Takes out of a mirrored request every vault value its chat's turn read, before the card is
   * stored, broadcast and backed up (`turnSecretScrubber.scrubIn`); unchanged when left out.
   */
  scrub?<T>(value: T, sessionId: string): T;
  openRequestCard(requestId: string): CardRow | null;
  reportsSince(sessionId: string, kinds: readonly AssistantCardKind[], since: number): number;
  lateReply(reply: LateReply): void;
  /**
   * Whether the turn of this chat that is ending answers a reply the user gave on a card
   * (`cardReplyFollowups.answering`): its late-reply news then says the user has the answer. Asked
   * from this `turn_ended` listener, which is started before the follow-ups' own, so the reply is
   * still known. Never when left out.
   */
  answersCardReply?(sessionId: string): boolean;
  graceMs?: number;
}

/** The `approval_resolved` reason of a card nobody answered before its deadline. */
export const EXPIRED_REASON = "expired";
export const EXPIRED_NOTE = "Expired: nobody answered in time, so nothing was done";
/** Why a card that takes a password typed into PPM is answered there and nowhere else. */
export const PPM_ONLY_REASON = "Answer it in the chat in PPM: it needs a password typed there, which is never asked for anywhere else.";
const PPM_ONLY_TITLES: Record<"db_execute" | "vault", string> = {
  db_execute: "A database change waits for your approval",
  vault: "A vault item waits to be unlocked",
};

const TRANSIENT = /rate.?limit|overloaded|\b429\b|\b529\b|usage limit|too many requests/i;
const MAX_EXPECTED = 200;
const EXPECT_TTL_MS = 24 * 60 * 60_000;
const log = createLogger("assistant-cards");

/** Whether a stop was the provider being busy, not the work failing. */
export function isTransientStop(p: Pick<ChatLifecycleEvents["turn_ended"], "stop" | "error">): boolean {
  return TRANSIENT.test(`${p.stop?.message ?? ""} ${p.error ?? ""}`);
}

export function createManagerSignals(deps: ManagerSignalsDeps) {
  const graceMs = deps.graceMs ?? FAILED_CARD_GRACE_MS;
  /** Manager chats owing the Assistant an answer: manager id → who asked, turn ends to skip, when. */
  const expected = new Map<string, { assistant: string; project: string; skip: number; at: number }>();
  const timers = new Set<Cancel>();
  let stops: Array<() => void> = [];

  /** Where a waiting card of this chat goes: its manager's card, or the chat's own; null for none. */
  function ownerOf(p: { sessionId: string; projectName: string; providerId: string }):
    { projectName: string; projectPath: string; sessionId: string; chat?: { title: string; providerId: string } } | null {
    const m = deps.managerFor(p.sessionId);
    if (m) return m;
    let c: ChatCardRef | null = null;
    try { c = deps.chatFor?.(p) ?? null; } catch (e) { log.warn(`session=${p.sessionId} could not tell whose card this is: ${(e as Error).message}`); }
    return c ? { projectName: c.projectName, projectPath: c.projectPath, sessionId: c.sessionId, chat: { title: c.title, providerId: c.providerId } } : null;
  }

  function onApprovalShown(p: ChatLifecycleEvents["approval_shown"]): void {
    if (deps.openRequestCard(p.card.requestId)) return;
    const m = ownerOf(p);
    if (!m) return;
    const scrub = <T>(v: T): T => (deps.scrub ? deps.scrub(v, p.sessionId) : v);
    const deciding = scrub(decidingInput(p.card));
    const question = p.card.isQuestion;
    const questions = scrub(question ? (p.card.questions ?? normalizeClaudeQuestions(p.card.input)) : []);
    const first = questions[0]?.question;
    deps.cards.create({
      kind: question ? "question" : "approval",
      projectName: m.projectName, projectPath: m.projectPath, sessionId: m.sessionId,
      title: question ? cleanCardTitle(first, "Question") : cleanCardTitle(deciding.title, "Approval"),
      payload: {
        requestId: p.card.requestId,
        ...(question ? { questions } : { deciding }),
        ...(m.chat ? { chat: m.chat } : {}),
        ...(p.card.expiresAt ? { expiresAt: p.card.expiresAt } : {}),
      },
    });
  }

  function onPpmOnlyCardShown(p: ChatLifecycleEvents["ppm_only_card_shown"]): void {
    if (deps.openRequestCard(p.requestId)) return;
    const m = ownerOf(p);
    if (!m) return;
    const title = PPM_ONLY_TITLES[p.kind];
    deps.cards.create({
      kind: "approval",
      projectName: m.projectName, projectPath: m.projectPath, sessionId: m.sessionId,
      title,
      payload: {
        requestId: p.requestId,
        answerInPpm: p.kind,
        // Nothing of the request itself: the card only says the chat waits, and where.
        deciding: { kind: p.kind, title, facts: [], text: "", complete: false, incompleteReason: PPM_ONLY_REASON },
        ...(m.chat ? { chat: m.chat } : {}),
      },
    });
  }

  function onApprovalResolved(p: ChatLifecycleEvents["approval_resolved"]): void {
    // An answer given on the card itself is recorded by the card's own route.
    if (p.by === "assistant_card") return;
    const row = deps.openRequestCard(p.requestId);
    if (!row) return;
    // Only a person's answer is `answered`; one given in PPM's chat over HTTP (a session tool's or a
    // database card) names nobody in `by`, and is the chat's all the same.
    const answered = p.reason === "answered";
    const chat = row.payload.chat ? "in the chat" : "in the manager chat";
    const where = p.by === "telegram" ? "on Telegram" : answered ? chat : null;
    deps.cards.transition(row.id, "resolved", {
      by: answered ? "user" : "ppm", channel: p.by === "telegram" ? "telegram" : "chat", at: deps.clock.now(),
      ...(answered ? { approved: p.approved } : {}),
      note: where ? `Answered ${where}` : p.reason === EXPIRED_REASON ? EXPIRED_NOTE : "No longer waiting",
    });
  }

  function onTurnEnded(p: ChatLifecycleEvents["turn_ended"]): void {
    const m = deps.managerFor(p.sessionId);
    if (!m) return;
    const id = resolveMigratedSession(p.sessionId);
    const owed = expected.get(id);
    if (owed) {
      if (owed.skip > 0) owed.skip--;
      else {
        expected.delete(id);
        const text = p.finalText?.trim();
        let answeredUser = false;
        try { answeredUser = deps.answersCardReply?.(id) ?? false; } catch { /* unknown: news as before */ }
        if (p.outcome === "done" && text) {
          // The Assistant still hears its answer (the same turn may answer both), told that the user
          // has it already.
          if (answeredUser) log.info(`session=${id} the turn also answered the user's reply on a card; the Assistant is told not to repeat it`);
          deps.lateReply({
            assistantSessionId: owed.assistant, managerSessionId: id, project: m.projectName, text, at: deps.clock.now(),
            ...(answeredUser ? { userHasAnswer: true as const } : {}),
          });
        }
      }
    }
    if (p.outcome === "done" || p.cancelledBy || isTransientStop(p)) return;
    const endedAt = deps.clock.now();
    const why = p.stop ? describeTurnStop(p.stop) : { title: "Stopped by an error", detail: p.error ?? null };
    const cancel = deps.clock.setTimer(() => {
      timers.delete(cancel);
      try {
        if (deps.reportsSince(id, REPORT_KINDS, endedAt) > 0) return;
        deps.cards.create({
          kind: "failed", projectName: m.projectName, projectPath: m.projectPath, sessionId: id,
          title: cleanCardTitle(why.title, "The manager chat stopped"),
          body: cleanCardBody([why.detail, p.outcome === "failed" ? p.error : null].filter(Boolean).join("\n"), 1000),
          payload: { detected: true },
        });
      } catch (e) {
        log.warn(`session=${id} could not raise a failed card: ${(e as Error).message}`);
      }
    }, graceMs);
    timers.add(cancel);
  }

  return {
    start(): void {
      if (stops.length) return;
      stops = [
        deps.lifecycle.on("approval_shown", onApprovalShown),
        deps.lifecycle.on("ppm_only_card_shown", onPpmOnlyCardShown),
        deps.lifecycle.on("approval_resolved", onApprovalResolved),
        deps.lifecycle.on("turn_ended", onTurnEnded),
      ];
    },
    stop(): void {
      for (const s of stops) s();
      stops = [];
      for (const cancel of timers) cancel();
      timers.clear();
      expected.clear();
    },
    /** The Assistant messaged a manager and nothing claimed the answer: its next turn end is news. */
    expectReply(assistantSessionId: string, managerSessionId: string, project: string, queued: boolean): void {
      const now = deps.clock.now();
      for (const [key, e] of expected) if (now - e.at > EXPECT_TTL_MS) expected.delete(key);
      expected.set(resolveMigratedSession(managerSessionId), { assistant: assistantSessionId, project, skip: queued ? 1 : 0, at: now });
      if (expected.size > MAX_EXPECTED) expected.delete(expected.keys().next().value!);
    },
  };
}

export type ManagerSignals = ReturnType<typeof createManagerSignals>;
