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

/**
 * What PPM itself sees in a manager chat, turned into cards and news. Only the manager chat
 * itself: its child chats' approvals and questions are the manager's to relay.
 *
 * - An approval or question the manager chat shows becomes a card mirroring it; the request
 *   ending anywhere (answered in the chat, on Telegram, by the turn ending) resolves the card.
 * - A manager turn that failed becomes a `failed` card after a grace period, unless the manager
 *   reported in between. A turn the user stopped, or one cut short by a rate limit or an
 *   overloaded provider, is not a failure the user needs a card for.
 * - The end of a manager turn that took an Assistant message nothing waited for is a late reply:
 *   news for the Assistant, no card.
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
  openRequestCard(requestId: string): CardRow | null;
  reportsSince(sessionId: string, kinds: readonly AssistantCardKind[], since: number): number;
  lateReply(reply: LateReply): void;
  graceMs?: number;
}

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

  function onApprovalShown(p: ChatLifecycleEvents["approval_shown"]): void {
    const m = deps.managerFor(p.sessionId);
    if (!m || deps.openRequestCard(p.card.requestId)) return;
    const deciding = decidingInput(p.card);
    const question = p.card.isQuestion;
    const questions = question ? (p.card.questions ?? normalizeClaudeQuestions(p.card.input)) : [];
    const first = questions[0]?.question;
    deps.cards.create({
      kind: question ? "question" : "approval",
      projectName: m.projectName, projectPath: m.projectPath, sessionId: m.sessionId,
      title: question ? cleanCardTitle(first, "Question") : cleanCardTitle(deciding.title, "Approval"),
      payload: {
        requestId: p.card.requestId,
        ...(question ? { questions } : { deciding }),
      },
    });
  }

  function onApprovalResolved(p: ChatLifecycleEvents["approval_resolved"]): void {
    // An answer given on the card itself is recorded by the card's own route.
    if (p.by === "assistant_card") return;
    const row = deps.openRequestCard(p.requestId);
    if (!row) return;
    const where = p.by === "telegram" ? "on Telegram" : p.by ? "in the manager chat" : null;
    deps.cards.transition(row.id, "resolved", {
      by: p.by ? "user" : "ppm", channel: p.by === "telegram" ? "telegram" : "chat", at: deps.clock.now(),
      ...(p.by ? { approved: p.approved } : {}),
      note: where ? `Answered ${where}` : "No longer waiting",
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
        if (p.outcome === "done" && text) {
          deps.lateReply({ assistantSessionId: owed.assistant, managerSessionId: id, project: m.projectName, text, at: deps.clock.now() });
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
