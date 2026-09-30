/**
 * Message handlers for the `/ws/global` agent-transcript protocol (see
 * `src/shared/agent-transcript-protocol.ts`). Per-client caps, `subId`
 * bookkeeping and cross-hub client drop live in `agent-transcript-hub-registry.ts`;
 * this module is only the four message shapes and their validation.
 */
import { assertSessionInProject } from "./session-ownership.ts";
import { mapOwnershipErrorCode } from "./agent-transcript-error-map.ts";
import { sendWsMessage, type AgentTranscriptWsLike } from "./agent-transcript-ws-like.ts";
import { addTranscriptSubscription } from "./agent-transcript-session-hub.ts";
import { addActivitySubscription } from "./agent-transcript-session-hub-activity.ts";
import {
  dropClientEverywhere, getOrCreateHub, maybeDropHub, projectPathFor,
  registerActivitySub, registerTranscriptSub, totalTranscriptSubs, transcriptSubCountForClient,
  unregisterActivitySub, unregisterTranscriptSub,
} from "./agent-transcript-hub-registry.ts";
import {
  MAX_TRANSCRIPT_SUBS_PER_CLIENT, MAX_TRANSCRIPT_SUBS_PER_SERVER,
  type AgentActivitySubscribeMsg, type AgentActivityUnsubscribeMsg,
  type AgentTranscriptErrorMsg, type AgentTranscriptSubscribeMsg, type AgentTranscriptUnsubscribeMsg,
} from "../../shared/agent-transcript-protocol.ts";

function sendError(ws: AgentTranscriptWsLike, subId: string, code: AgentTranscriptErrorMsg["code"]): void {
  sendWsMessage(ws, { type: "agent-transcript:error", subId, code } satisfies AgentTranscriptErrorMsg);
}

export function handleAgentTranscriptSubscribe(ws: AgentTranscriptWsLike, msg: AgentTranscriptSubscribeMsg): void {
  const { subId, projectName, providerId, sessionId, source, cursor } = msg;
  if (typeof subId !== "string" || !subId) return;
  if (
    typeof projectName !== "string" || (providerId !== "claude" && providerId !== "codex") ||
    typeof sessionId !== "string" || !source || typeof source !== "object" ||
    (source.kind !== "card" && source.kind !== "member")
  ) {
    return sendError(ws, subId, "bad_request");
  }

  const projectPath = projectPathFor(projectName);
  if (!projectPath) return sendError(ws, subId, "not_found");

  // Replacing an existing subId costs nothing against the cap — drop it first.
  unregisterTranscriptSub(ws, subId);

  if (transcriptSubCountForClient(ws) >= MAX_TRANSCRIPT_SUBS_PER_CLIENT) return sendError(ws, subId, "limit");
  if (totalTranscriptSubs() >= MAX_TRANSCRIPT_SUBS_PER_SERVER) return sendError(ws, subId, "limit");

  const owned = assertSessionInProject({ providerId, sessionId, projectPath });
  if (!owned.ok) return sendError(ws, subId, mapOwnershipErrorCode(owned.code));

  const hub = getOrCreateHub(owned);
  const result = addTranscriptSubscription(hub, ws, subId, source, cursor);
  if (!result.ok) {
    maybeDropHub(hub.key);
    return sendError(ws, subId, result.code ?? "bad_request");
  }

  registerTranscriptSub(ws, subId, hub.key);
  if (result.sendFailed) dropClientEverywhere(ws);
}

export function handleAgentTranscriptUnsubscribe(ws: AgentTranscriptWsLike, msg: AgentTranscriptUnsubscribeMsg): void {
  if (typeof msg.subId === "string") unregisterTranscriptSub(ws, msg.subId);
}

export function handleAgentActivitySubscribe(ws: AgentTranscriptWsLike, msg: AgentActivitySubscribeMsg): void {
  const { subId, projectName, providerId, sessionId } = msg;
  if (typeof subId !== "string" || !subId) return;
  if (typeof projectName !== "string" || (providerId !== "claude" && providerId !== "codex") || typeof sessionId !== "string") {
    return sendError(ws, subId, "bad_request");
  }
  const projectPath = projectPathFor(projectName);
  if (!projectPath) return sendError(ws, subId, "not_found");

  unregisterActivitySub(ws, subId);

  const owned = assertSessionInProject({ providerId, sessionId, projectPath });
  if (!owned.ok) return sendError(ws, subId, mapOwnershipErrorCode(owned.code));

  const hub = getOrCreateHub(owned);
  addActivitySubscription(hub, ws, subId);
  registerActivitySub(ws, subId, hub.key);
}

export function handleAgentActivityUnsubscribe(ws: AgentTranscriptWsLike, msg: AgentActivityUnsubscribeMsg): void {
  if (typeof msg.subId === "string") unregisterActivitySub(ws, msg.subId);
}

export function handleAgentTranscriptPing(ws: AgentTranscriptWsLike): void {
  sendWsMessage(ws, { type: "pong" });
}

/** Socket closed: drop every transcript and activity subscription it held. */
export function handleAgentTranscriptClientClosed(ws: AgentTranscriptWsLike): void {
  dropClientEverywhere(ws);
}

export {
  _debugHubSnapshotForTest, _getSessionHubForTest, _resetAgentTranscriptHubForTest,
} from "./agent-transcript-hub-registry.ts";
