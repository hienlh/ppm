import { isPermissionEscalation, type SendToSessionResult } from "../../shared/session-collab.ts";
import { textResult, type Json } from "../mcp-http-endpoint.ts";
import {
  effectivePermissionMode, resolveTarget, type CollabCaller, type CollabEnv, type CollabTarget,
} from "./collab-context.ts";
import { assistantSendCheck } from "./collab-send-assistant.ts";
import { isManagerTarget, managerSendCheck, UNATTENDED_MANAGERS_ONLY, type ManagerSendPlan } from "./collab-send-manager.ts";
import { deliverAndWait } from "./collab-deliver.ts";
import { jsonResult, noteAiTextRead, statusOf } from "./collab-status.ts";
import { collabTextTooLarge } from "./session-collab-tool.ts";

/**
 * `send_to_session`. The target is proven to be in the caller's project before anything else.
 * Then the user is asked when the pair reached its limit of automatic messages, or when the
 * target runs with more permissions than the caller (an AI could otherwise act through it with
 * rights it was never given) — shown the whole message. A message the target is waiting for — the
 * target called with `wait: true` and this caller is who it waits on — is that wait's reply and is
 * not delivered again; any other, a reply that came after the wait ended included, is a new message.
 * The PPM Assistant follows its own rules instead (`collab-send-manager.ts`, `collab-send-assistant.ts`).
 */

/**
 * The cards a send may need, in order; null when it may go, else the refusal for the AI. A
 * message that may go has been counted against the pair's limit — in the same synchronous step as
 * the check, so sends arriving together cannot all pass it; a refused one is taken back.
 */
export async function sendChecks(env: CollabEnv, caller: CollabCaller, target: CollabTarget, message: string, signal: AbortSignal): Promise<string | null> {
  const limit = env.settings().maxAutoMessagesPerPair;
  if (env.pairs.remaining(caller.sessionId, target.sessionId, limit) <= 0) {
    const answer = await env.approve(caller.sessionId, {
      kind: "pair_limit", targetSessionId: target.sessionId, targetTitle: target.title,
      sent: env.pairs.count(caller.sessionId, target.sessionId), limit, grant: limit,
    }, signal);
    if (!answer.allowed) return `Your session and "${target.title}" reached their limit of ${limit} automatic messages. ${answer.message}`;
    env.pairs.grant(caller.sessionId, target.sessionId, limit);
  }
  // The first message since the counter last started over may be the pair's first ever: announce the link.
  if (env.pairs.record(caller.sessionId, target.sessionId) === 1) env.announceLinks(caller.projectName, [caller.sessionId, target.sessionId]);

  // What the sending session actually runs under: a session with no mode of its own runs bypass.
  const senderMode = effectivePermissionMode(env, caller.sessionId, caller.providerId) ?? "bypassPermissions";
  const targetMode = effectivePermissionMode(env, target.sessionId, target.providerId);
  if (isPermissionEscalation(senderMode, targetMode) && !env.pairs.escalationAllowed(caller.sessionId, target.sessionId, targetMode)) {
    const answer = await env.approve(caller.sessionId, {
      kind: "escalation", targetSessionId: target.sessionId, targetTitle: target.title,
      senderMode, targetMode: targetMode ?? "unknown", message,
    }, signal);
    if (!answer.allowed) {
      env.pairs.unrecord(caller.sessionId, target.sessionId);
      return `"${target.title}" runs with more permissions than your session, so the user was asked first. ${answer.message}`;
    }
    if (answer.answer === "allow_session") env.pairs.setAllowEscalation(caller.sessionId, target.sessionId, targetMode);
  }
  return null;
}

export async function sendToSessionTool(env: CollabEnv, caller: CollabCaller, args: Json, signal: AbortSignal): Promise<Json> {
  const message = typeof args.message === "string" ? args.message : "";
  if (!message.trim()) return textResult("`message` is required.", true);
  const tooLarge = collabTextTooLarge("message", message);
  if (tooLarge) return textResult(tooLarge, true);
  if (args.wait !== undefined && typeof args.wait !== "boolean") return textResult("`wait` must be true or false.", true);
  const resolved = resolveTarget(env, caller, args.session_id);
  if (!resolved.ok) return textResult(resolved.message, true);
  const target = resolved.value;

  // The PPM Assistant messages a project's manager chat without a card, within the limits that
  // replace it, and asks the user about every other message instead of the pair and mode checks;
  // a message the user approved must still run in the mode they approved when it is handed over.
  let expectedMode: string | undefined;
  let manager: Extract<ManagerSendPlan, { ok: true }> | null = null;
  if (caller.kind === "assistant" && isManagerTarget(env, target)) {
    const plan = await managerSendCheck(env, caller, target, message, signal);
    if (!plan.ok) return textResult(plan.message, true);
    manager = plan;
    expectedMode = plan.expectedMode;
  } else if (caller.kind === "assistant") {
    if (caller.unattended) return textResult(UNATTENDED_MANAGERS_ONLY, true);
    const check = await assistantSendCheck(env, caller, target, message, signal);
    if (!check.ok) return textResult(check.message, true);
    expectedMode = check.mode;
  } else {
    const refused = await sendChecks(env, caller, target, message, signal);
    if (refused) return textResult(refused, true);
  }

  try {
    return await deliverChecked(env, caller, target, message, args.wait === true, signal, expectedMode, manager);
  } catch (e) {
    // Whatever failed after the checks, a message that did not go gives back what it reserved.
    manager?.release();
    throw e;
  }
}

async function deliverChecked(
  env: CollabEnv, caller: CollabCaller, target: CollabTarget, message: string, wait: boolean, signal: AbortSignal,
  expectedMode: string | undefined, manager: Extract<ManagerSendPlan, { ok: true }> | null,
): Promise<Json> {
  // The target is waiting for exactly this: hand it over as the wait's result, once.
  const sentAt = new Date().toISOString();
  const turnId = env.live(caller.sessionId)?.currentTurnId;
  if (env.waits.claimReply(caller.sessionId, target.sessionId, { text: message, ...(turnId ? { turnId } : {}), sentAt })) {
    const result: SendToSessionResult = { delivered: "inserted", status: statusOf(env, target.sessionId, target.providerId, caller.sessionId) };
    noteAiTextRead(env, caller, [result.status]);
    return jsonResult(result);
  }

  const out = await deliverAndWait(env, {
    caller, target, body: message, wait, signal, ...(expectedMode ? { expectedMode } : {}),
    ...(manager ? { priority: manager.priority, provenance: manager.provenance } : {}),
  });
  if (!out.ok) {
    // Never reached the target: it does not count against the pair's limit or the Assistant's budgets.
    if (manager) manager.release();
    else if (caller.kind !== "assistant") env.pairs.unrecord(caller.sessionId, target.sessionId);
    return textResult(out.message, true);
  }
  // A manager's answer nobody waited for (or that came after the wait gave up) comes back to the
  // Assistant later, as news in a turn PPM starts.
  const claimed = out.reply && (out.reply.replied || out.reply.reason === "turn_ended_without_reply");
  // After a wait that timed out, the turn running now is the one that took the message. A wait
  // that ended on a card ended at once: the message is where an unwaited one would be.
  const unwaited = !out.reply || (!out.reply.replied && out.reply.reason === "waiting_for_user");
  if (manager && !claimed) env.managerAsked?.(caller.sessionId, target.sessionId, target.projectName, out.delivered === "queued" && unwaited);
  const result: SendToSessionResult & { project?: string } = {
    delivered: out.delivered,
    status: statusOf(env, target.sessionId, target.providerId, caller.sessionId, !!out.reply),
    ...(out.reply ? { reply: out.reply } : {}),
    // The Assistant's targets live in other projects; its tool card opens them there.
    ...(caller.kind === "assistant" ? { project: target.projectName } : {}),
  };
  noteAiTextRead(env, caller, [result.status], out.reply);
  return jsonResult(result);
}
