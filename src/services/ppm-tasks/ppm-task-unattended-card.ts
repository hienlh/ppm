/**
 * Task changes the PPM Assistant made in a turn nobody watched (one PPM started: a watch, a wake)
 * are allowed, recorded `unattended` in history, and shown to the user on one Assistant card per
 * such turn, "Changed N tasks while you were away", listing each change with the history id that
 * undoes it. The card goes out through the hub's own card path (PPM, and Telegram with the quiet
 * hours hold). Asking the Assistant to "undo #…" (in PPM, or by replying to the card on Telegram)
 * starts a turn the user wrote in, which can undo; every listed task change can also be undone
 * from the task's History in PPM.
 *
 * Changes are gathered during the turn and the card is made when the turn ends, so one turn makes
 * one card. A restart mid-turn loses the gathering, never the changes or their history marks.
 */
import { createLogger } from "../logger.ts";
import { chatLifecycle } from "../chat-control/chat-lifecycle.ts";
import { resolveMigratedSession } from "../db.service.ts";

export interface UnattendedChange {
  /** The history row that undoes it; null for a project settings change, which cannot be undone. */
  historyId: number | null;
  projectKey: string;
  /** "ppm/12 "Title": closed" — already cleaned for display. */
  summary: string;
}

export interface UnattendedCard {
  title: string;
  body: string;
}

/** Where a finished turn's card goes; the hub's card service by default. */
export type UnattendedCardSink = (card: UnattendedCard) => void;

const log = createLogger("ppm-tasks");
const MAX_LISTED = 25;
const MAX_SESSIONS = 256;
const pending = new Map<string, UnattendedChange[]>();

const liveSink: UnattendedCardSink = (card) => {
  // Loaded on first use: the card service reaches the hub, which loads after the task store.
  void import("../assistant-cards/assistant-cards.service.ts")
    .then(({ assistantCards }) => {
      assistantCards.create({ kind: "done", projectName: null, projectPath: null, sessionId: null, title: card.title, body: card.body });
    })
    .catch((e) => log.warn(`could not post the "while you were away" task card: ${(e as Error).message}`));
};
let sink: UnattendedCardSink = liveSink;

/** Tests read the card instead of posting it; null puts the hub back. */
export function setUnattendedCardSink(next: UnattendedCardSink | null): void {
  sink = next ?? liveSink;
}

/** Remembers one change of an unattended Assistant turn, to list on the turn's card. */
export function noteUnattendedChange(assistantSessionId: string, change: UnattendedChange): void {
  const key = resolveMigratedSession(assistantSessionId);
  const list = pending.get(key) ?? [];
  list.push(change);
  pending.delete(key);
  pending.set(key, list);
  if (pending.size > MAX_SESSIONS) pending.delete(pending.keys().next().value!);
}

/** The card for these changes. */
export function unattendedCard(changes: readonly UnattendedChange[]): UnattendedCard {
  const n = changes.length;
  const listed = changes.slice(0, MAX_LISTED).map((c) =>
    `- ${c.summary}${c.historyId !== null ? ` · undo #${c.historyId}` : " (a settings change: cannot be undone)"}`);
  if (n > MAX_LISTED) listed.push(`- …and ${n - MAX_LISTED} more (see each task's History in PPM)`);
  const example = changes.find((c) => c.historyId !== null)?.historyId;
  return {
    title: `PPM Assistant made ${n} task change${n === 1 ? "" : "s"} while you were away`,
    body: [
      "Made in a turn PPM started, not one you wrote in:",
      ...listed,
      ...(example != null
        ? ["", `To undo one, tell the Assistant (for example "undo #${example}") or press Undo on it in the task's History in PPM.`]
        : []),
    ].join("\n"),
  };
}

/** Posts the turn's card, if the turn changed anything. */
export function flushUnattendedChanges(assistantSessionId: string): void {
  const key = resolveMigratedSession(assistantSessionId);
  const changes = pending.get(key) ?? pending.get(assistantSessionId);
  pending.delete(key);
  pending.delete(assistantSessionId);
  if (!changes?.length) return;
  try {
    sink(unattendedCard(changes));
  } catch (e) {
    log.warn(`could not post the "while you were away" task card: ${(e as Error).message}`);
  }
}

chatLifecycle.on("turn_ended", (e) => {
  if (e.turnStillRunning) return;
  if (pending.size === 0) return;
  flushUnattendedChanges(e.sessionId);
});

chatLifecycle.on("migrated", (e) => {
  const list = pending.get(e.oldSessionId);
  if (!list) return;
  pending.delete(e.oldSessionId);
  pending.set(e.newSessionId, [...(pending.get(e.newSessionId) ?? []), ...list]);
});
