import { createLogger } from "../logger.ts";
import { resolveMigratedSession } from "../db.service.ts";
import { listWakePendingRows, type CardRow } from "../assistant-cards/assistant-cards-db.ts";
import type { WakeNewsNotice, WakeReportKind } from "../../shared/assistant-wake-news.ts";
import type { WakeItem, WakeSource } from "./assistant-wake-queue.ts";

/**
 * The wake queue's two sources of manager news.
 *
 * - Cards: a `done`, `failed`, `urgent` or digest report is news for the main Assistant session.
 *   The card's `wake` column keeps it pending across a restart. With no main session the news
 *   waits (and the card stands in front of the user regardless).
 * - Late replies: a manager answering a message nobody waited for. Kept in memory: after a
 *   restart the answer is still in the manager chat, where `session_status` reads it.
 */

const MAX_ATTEMPTS = 3;
const MAX_LATE_REPLIES = 200;
const log = createLogger("assistant-wake");

const REPORT_KINDS: readonly string[] = ["done", "failed", "urgent", "digest"];

export interface CardSourceDeps {
  mainSession(): string | null;
  /** Cards whose news the Assistant has not been told yet (wake = pending). */
  pendingRows?(): CardRow[];
  projectNameOf(row: CardRow): string;
  setWake(id: string, wake: "pending" | "delivered"): void;
}

function newsOf(row: CardRow, project: string): WakeNewsNotice {
  return {
    kind: "report", key: row.id, project, sessionId: row.sessionId ?? "", at: row.createdAt,
    reportKind: (REPORT_KINDS.includes(row.kind) ? row.kind : "done") as WakeReportKind,
    title: row.title,
    ...(row.body ? { body: row.body } : {}),
    ...(row.payload.items?.length ? { items: row.payload.items } : {}),
    ...(row.payload.subagent ? { subagent: true } : {}),
  };
}

export function createCardWakeSource(deps: CardSourceDeps): WakeSource {
  const attempts = new Map<string, number>();
  const rows = () => (deps.pendingRows ?? listWakePendingRows)();
  let warnedNoMain = false;
  const deliver = (items: WakeItem[]) => {
    for (const i of items) { attempts.delete(i.key); deps.setWake(i.key, "delivered"); }
  };
  return {
    name: "cards",
    sessions() {
      if (rows().length === 0) return [];
      const main = deps.mainSession();
      if (!main && !warnedNoMain) {
        warnedNoMain = true;
        log.warn("manager news waits: there is no main Assistant session to tell (the cards stand)");
      }
      if (main) warnedNoMain = false;
      return main ? [main] : [];
    },
    pending(sessionId) {
      const main = deps.mainSession();
      if (!main || resolveMigratedSession(sessionId) !== main) return [];
      return rows().map((row) => ({ key: row.id, at: row.createdAt, urgent: row.kind === "urgent", news: newsOf(row, deps.projectNameOf(row)) }));
    },
    delivered: (_id, items) => deliver(items),
    ended: (_id, items) => deliver(items),
    failed(_id, items) {
      let retry = false;
      for (const i of items) {
        const n = (attempts.get(i.key) ?? 0) + 1;
        if (n >= MAX_ATTEMPTS) {
          attempts.delete(i.key);
          deps.setWake(i.key, "delivered");
          log.warn(`card ${i.key}: the Assistant could not be told after ${n} tries; the card stands`);
        } else {
          attempts.set(i.key, n);
          retry = true;
        }
      }
      return retry;
    },
  };
}

export interface LateReply {
  assistantSessionId: string;
  managerSessionId: string;
  project: string;
  text: string;
  at: number;
}

export function createLateReplySource(onNews: (assistantSessionId: string) => void) {
  const replies: Array<LateReply & { key: string; attempts: number }> = [];
  const remove = (items: WakeItem[]) => {
    const keys = new Set(items.map((i) => i.key));
    for (let i = replies.length - 1; i >= 0; i--) if (keys.has(replies[i]!.key)) replies.splice(i, 1);
  };
  const source: WakeSource & { add(reply: LateReply): void; size(): number } = {
    name: "late-replies",
    add(reply) {
      replies.push({ ...reply, key: crypto.randomUUID(), attempts: 0 });
      if (replies.length > MAX_LATE_REPLIES) replies.splice(0, replies.length - MAX_LATE_REPLIES);
      onNews(reply.assistantSessionId);
    },
    size: () => replies.length,
    sessions: () => [...new Set(replies.map((r) => r.assistantSessionId))],
    pending(sessionId) {
      const id = resolveMigratedSession(sessionId);
      return replies.filter((r) => resolveMigratedSession(r.assistantSessionId) === id).map((r) => ({
        key: r.key, at: r.at,
        news: { kind: "late_reply", key: r.key, project: r.project, sessionId: r.managerSessionId, at: r.at, text: r.text },
      }));
    },
    delivered: (_id, items) => remove(items),
    ended: (_id, items) => remove(items),
    failed(_id, items) {
      const keys = new Set(items.map((i) => i.key));
      for (const r of replies) if (keys.has(r.key)) r.attempts++;
      const gone = replies.filter((r) => keys.has(r.key) && r.attempts >= MAX_ATTEMPTS);
      remove(gone.map((r) => ({ key: r.key, at: r.at })));
      return replies.some((r) => keys.has(r.key));
    },
  };
  return source;
}
