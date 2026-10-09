import type { Json } from "../mcp-http-endpoint.ts";
import { getSessionTitle } from "../db.service.ts";
import { CHAT_SEND_MESSAGE_TOOL } from "../../shared/assistant-tool-names.ts";
import { resolveAssistantProject, resolveAssistantSessionTarget } from "./assistant-project-scope.ts";
import { chatSendSummary, type ModeSource } from "./assistant-approval-summary.ts";
import type { AskApproval } from "./assistant-approval-broker.ts";
import { errorResult, jsonResult, notApprovedResult } from "./assistant-tool-output.ts";
import { MAX_CHAT_MESSAGE_CHARS } from "./assistant-mcp-tools.ts";

/**
 * `chat_send_message`: the Assistant sends a message into one of the user's chats, which then
 * runs it as if the user had typed it — so it always asks first. The card names the chat and
 * the permission mode the message will run in, with where that mode came from: a chat set to
 * bypass permissions runs whatever follows unasked, and the user must see that before allowing.
 *
 * Never into an Assistant chat, never into a chat waiting on its own approval card (a message
 * would cancel that request), and only into a chat proven to belong to the named project.
 */

export type DeliverResult = { ok: true; sessionId: string } | { ok: false; error: string };

export const TARGET_HAS_PENDING_APPROVAL =
  "That chat is waiting for the user to answer an approval card. A message now would cancel that request, "
  + "so it was not sent; ask the user to answer it in that chat first.";

/** The chat socket layer's side of sending (`ws/chat.ts` registers it). */
export interface AssistantChatDelivery {
  /** The mode a message would run in now, where that came from, and whether a card is waiting. */
  inspect(sessionId: string, providerId: string): { mode: string; source: ModeSource; pendingApproval: boolean };
  /** Sends `text` to run in `permissionMode`; refuses if the chat would now run it in another mode. */
  deliver(target: { sessionId: string; projectName: string; providerId: string }, text: string, permissionMode: string): Promise<DeliverResult>;
}

let delivery: AssistantChatDelivery | null = null;

export function setAssistantChatDelivery(d: AssistantChatDelivery | null): void {
  delivery = d;
}

/** The registered delivery, or null when no chat socket layer runs in this process. */
export const assistantChatDelivery = (): AssistantChatDelivery | null => delivery;

export async function chatSendMessage(
  args: Record<string, unknown>,
  ask: AskApproval,
  deps: { delivery?: AssistantChatDelivery | null; title?: (sessionId: string) => string | null } = {},
): Promise<Json> {
  const project = resolveAssistantProject(args.project);
  if (!project.ok) return errorResult(project.error);
  const target = resolveAssistantSessionTarget(project.value, args.sessionId, args.providerId);
  if (!target.ok) return errorResult(target.error);
  if (typeof args.text !== "string" || !args.text.trim()) return errorResult("`text` is required: the message to send.");
  if (args.text.length > MAX_CHAT_MESSAGE_CHARS) return errorResult(`\`text\` is longer than ${MAX_CHAT_MESSAGE_CHARS} characters.`);
  const text = args.text;
  const chat = deps.delivery === undefined ? delivery : deps.delivery;
  if (!chat) return errorResult("Sending messages is not available in this PPM process.");

  const { sessionId, providerId } = target.value;
  const state = chat.inspect(sessionId, providerId);
  if (state.pendingApproval) return errorResult(TARGET_HAS_PENDING_APPROVAL);

  const summary = chatSendSummary({
    project: project.value.name, sessionId, providerId, sessionTitle: (deps.title ?? getSessionTitle)(sessionId),
    text, mode: state.mode, modeSource: state.source,
  });
  const verdict = await ask({
    tool: CHAT_SEND_MESSAGE_TOOL,
    input: { project: project.value.name, sessionId, providerId, permissionMode: state.mode, text },
    summary,
  });
  if (verdict.verdict !== "approved") return notApprovedResult("chat_send_message", verdict, { sessionId });

  const sent = await chat.deliver({ sessionId, projectName: project.value.name, providerId }, text, state.mode);
  if (!sent.ok) return errorResult(`Not sent: ${sent.error}`);
  return jsonResult({
    sent: true,
    project: project.value.name,
    sessionId: sent.sessionId,
    providerId,
    permissionMode: state.mode,
    note: "The chat is now working on it. Read its reply with chat_read_messages; it may take a while.",
  });
}
