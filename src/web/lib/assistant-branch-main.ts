/**
 * Whether moving the Assistant window from `from` to `to` (an edited message's fork, a fork, the
 * version switcher) makes `to` the main Assistant session: only a move away from the main session
 * does. A branch reached from a one-off session stays one, so opening an old session from a
 * notification and editing in it never takes over the conversation Telegram follows. Pure.
 */
export function branchTakesMain(from: string | null, to: string, mainSessionId: string | null): boolean {
  return !!from && !!mainSessionId && from === mainSessionId && to !== mainSessionId;
}
