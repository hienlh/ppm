import type { SessionCollabApprovalInput } from "../../shared/session-collab.ts";
import type { CollabApprovalOutcome } from "./collab-approval-broker.ts";
import type { CollabCaller, CollabEnv } from "./collab-context.ts";
import { COLLAB_APPROVAL_WAIT_MS } from "./session-collab-tool.ts";

/** What the AI reads when its card gave up because Antigravity was about to end the call. */
export const CALLER_DEADLINE_CARD_EXPIRED = "The user did not answer in time: Antigravity ends a tool call after 3 minutes, "
  + "so the card was withdrawn before that and nothing was done. This is not a refusal. Call the tool again to ask "
  + "the user again, or ask them in your reply first.";

/**
 * Asks the user on a card for no longer than the caller may wait. A caller whose provider cuts
 * tool calls off (`answerBy`, Antigravity) gets a card that gives up before the call is cut: the
 * broker then withdraws it, so it cannot be approved after the tool has already answered, and the
 * AI is told why rather than reading an ordinary timeout. Any other caller waits the full time.
 */
export async function askUser(env: CollabEnv, caller: CollabCaller, input: SessionCollabApprovalInput, signal: AbortSignal): Promise<CollabApprovalOutcome> {
  if (caller.answerBy === undefined) return env.approve(caller.sessionId, input, signal, COLLAB_APPROVAL_WAIT_MS);
  const waitMs = Math.max(0, Math.min(COLLAB_APPROVAL_WAIT_MS, caller.answerBy - Date.now()));
  const deadline: CollabApprovalOutcome = { allowed: false, reason: "timeout", message: CALLER_DEADLINE_CARD_EXPIRED };
  // No time left (an earlier card took it): a card nobody could answer is never shown.
  if (waitMs === 0) return deadline;
  const outcome = await env.approve(caller.sessionId, input, signal, waitMs);
  if (outcome.allowed || outcome.reason !== "timeout" || waitMs >= COLLAB_APPROVAL_WAIT_MS) return outcome;
  return deadline;
}
