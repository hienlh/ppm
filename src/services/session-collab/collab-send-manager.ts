import type { AssistantProvenance } from "../../shared/assistant-provenance.ts";
import { UNATTENDED_TURN_REFUSAL } from "../chat-control/chat-control.ts";
import { DUPLICATE_REFUSAL, looksLikeSecret, SECRET_REFUSAL } from "./assistant-send-guards.ts";
import type { CollabCaller, CollabEnv, CollabTarget } from "./collab-context.ts";
import { assistantSendCheck } from "./collab-send-assistant.ts";

/**
 * A PPM Assistant message to the current manager chat of the target's project: the one message
 * the Assistant sends without a card. What replaces the card, in order:
 *
 * - a text that looks like it holds a secret shows the ordinary message card in a turn the user
 *   started, and is refused in one PPM started;
 * - the same text to the same manager within the hour is dropped;
 * - in a turn PPM started, quiet hours, the hourly and daily budgets and the pair limit apply, and
 *   a budget running out pauses the Assistant until the user writes;
 * - every message carries a provenance block PPM writes from what it saw of the Assistant's turn,
 *   and goes `next` only when the user started that turn and nothing untrusted reached it.
 *
 * Whether the target is the manager is asked at every send, of the live table.
 */

export const UNATTENDED_MANAGERS_ONLY = `${UNATTENDED_TURN_REFUSAL} In such a turn you may only ask a project's manager chat for status.`;

export type ManagerSendPlan =
  | {
    ok: true;
    priority: "next" | "later";
    provenance: AssistantProvenance;
    /** Set when the user approved the message on a card: the mode it must still run in. */
    expectedMode?: string;
    /** Gives back what the send reserved, for a message that was not delivered. */
    release(): void;
  }
  | { ok: false; message: string };

/** Whether `target` is, right now, the manager chat of its own project. */
export function isManagerTarget(env: CollabEnv, target: CollabTarget): boolean {
  return !!env.managerOf && env.managerOf(target.projectPath) === target.sessionId;
}

/** What PPM writes about the Assistant's turn; an unattended turn is always PPM's. */
function provenanceOf(env: CollabEnv, caller: CollabCaller): AssistantProvenance {
  const seen = env.turnProvenance?.(caller.sessionId) ?? { startedBy: "ppm", untrusted: true, reason: "unknown" };
  return caller.unattended && seen.startedBy !== "ppm" ? { ...seen, startedBy: "ppm", untrusted: true, reason: seen.reason ?? "unknown" } : seen;
}

export async function managerSendCheck(
  env: CollabEnv, caller: CollabCaller, target: CollabTarget, message: string, signal: AbortSignal,
): Promise<ManagerSendPlan> {
  const refuse = (reason: string, text: string): ManagerSendPlan => {
    env.trace?.(caller.sessionId, "assistant_send_refused", { targetSessionId: target.sessionId, project: target.projectName, reason });
    return { ok: false, message: text };
  };
  const guards = env.assistantGuards;
  // Without the guards nothing could hold an unattended message back: none goes.
  if (caller.unattended && !guards) return refuse("no_guards", UNATTENDED_MANAGERS_ONLY);

  const secret = looksLikeSecret(message);
  if (secret && caller.unattended) return refuse("secret", SECRET_REFUSAL);
  // Claimed before any card, so text the user allowed is never then dropped as already sent.
  const releaseBody = guards ? guards.claimBody(caller.sessionId, target.sessionId, message) : () => {};
  if (!releaseBody) return refuse("duplicate", DUPLICATE_REFUSAL);

  let expectedMode: string | undefined;
  let releaseBudget = () => {};
  try {
    if (secret) {
      const card = await assistantSendCheck(env, caller, target, message, signal);
      if (!card.ok) {
        releaseBody();
        return card;
      }
      expectedMode = card.mode;
    }
    if (caller.unattended && guards) {
      const reserved = guards.reserveUnattended(caller.sessionId, target.sessionId, env.settings().maxAutoMessagesPerPair);
      if (!reserved.ok) {
        releaseBody();
        return refuse(reserved.reason, reserved.message);
      }
      releaseBudget = reserved.release;
    }
  } catch (e) {
    releaseBody();
    throw e;
  }

  const provenance = provenanceOf(env, caller);
  const clean = provenance.startedBy !== "ppm" && !provenance.untrusted;
  return {
    ok: true,
    priority: !caller.unattended && clean ? "next" : "later",
    provenance,
    ...(expectedMode ? { expectedMode } : {}),
    release: () => { releaseBody(); releaseBudget(); },
  };
}
