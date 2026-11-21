/**
 * Whether an idle `session_state` (the greeting a chat socket gets on every connect, reconnect
 * and resync, and after a model, effort or thinking change) has to reload the session's history.
 *
 * Reloading swaps every row the list draws for the transcript's copy, which hands a turn back
 * as one message per block where the stream drew it as one: everything above a reader who has
 * scrolled up moves. The chat socket drops every few minutes on a flaky link, so reloading on
 * every greeting moved the reader every few minutes. A greeting now names the last event number
 * the session broadcast (`streamSeq`); a tab holding that same number has missed nothing.
 *
 * Still reloaded: a turn that ended while this tab thought it was running (its `done` was lost),
 * a replay too long for the server's buffer, and any greeting from a server too old to send the
 * number, which keeps the previous rule (reload unless history has just loaded).
 */
export interface IdleGreeting {
  /** The last replay this tab took was truncated: frames are missing from its turn. */
  replayWasTruncated: boolean;
  /** This tab already showed the session idle before the greeting. */
  wasIdle: boolean;
  /** History finished loading moments ago (or is loading now) and is as new as the greeting. */
  historyFresh: boolean;
  /** The greeting's `streamSeq`; undefined from a server that does not send it. */
  serverSeq: number | undefined;
  /** The last event number this tab received. */
  clientSeq: number;
}

export function idleGreetingNeedsHistory(g: IdleGreeting): boolean {
  if (g.replayWasTruncated || !g.wasIdle) return true;
  if (g.historyFresh) return false;
  // A different number either way means events this tab never saw: newer ones, or a server that
  // restarted (its numbering starts again) and may have run turns since.
  if (typeof g.serverSeq === "number") return g.serverSeq !== g.clientSeq;
  return true;
}
