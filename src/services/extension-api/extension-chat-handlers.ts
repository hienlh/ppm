/**
 * `ppm.chat.*` — an extension drives a chat session with nobody watching: creates one in a
 * registered project, sends turns, cancels, polls the state, reads the last answer and opens
 * the chat as a tab in the browser that ran its command. Every turn goes through
 * `startHeadlessTurn`, so it runs on the same consumer a tab's turn does.
 */
import type { RpcChannel } from "../extension-rpc.ts";
import { chatService } from "../chat.service.ts";
import { providerRegistry } from "../../providers/registry.ts";
import { getProjects, getSessionProjectPath, getSessionProvider, resolveMigratedSession, setSessionMetadata, setSessionModel } from "../db.service.ts";
import { bindPickedAccount } from "../picked-account-binding.ts";
import { dbApprovalBroker } from "../db-ai-tools/db-approval-broker.ts";
import { broadcastExtMsg, recentCommandClient } from "../../server/ws/extensions.ts";
import { validateHeadlessSend } from "../../server/ws/chat-headless-turn-helpers.ts";
import type { ChatSendPayload } from "../../types/api.ts";

// The socket module is loaded on use, as the chat routes load it, so registering these
// handlers never pulls the whole chat socket in with the extension service.
const chatSocket = () => import("../../server/ws/chat.ts");
const headlessTurn = () => import("../../server/ws/chat-headless-turn.ts");

type Params = Record<string, unknown>;

function paramsOf(params: unknown[]): Params {
  const first = params[0];
  return first && typeof first === "object" ? first as Params : {};
}

function requireString(p: Params, key: string): string {
  const value = p[key];
  if (typeof value !== "string" || !value) throw new Error(`${key} is required`);
  return value;
}

/** A session an extension may act on: known to a provider or persisted, under its current id. */
function resolveSession(requestedId: string): { sessionId: string; providerId: string; projectPath: string | null } {
  const sessionId = resolveMigratedSession(requestedId);
  const live = chatService.getSession(sessionId);
  const projectPath = live?.projectPath ?? getSessionProjectPath(sessionId);
  if (!live && !projectPath) throw new Error("Session not found");
  const providerId = live?.providerId ?? getSessionProvider(sessionId) ?? providerRegistry.getDefault().id;
  return { sessionId, providerId, projectPath };
}

function projectNameOf(projectPath: string | null): string | undefined {
  if (!projectPath) return undefined;
  return getProjects().find((p) => p.path === projectPath)?.name;
}

export function registerExtensionChatHandlers(rpc: RpcChannel): void {
  rpc.onRequest("chat:listProjects", async () => getProjects().map((p) => ({ name: p.name, path: p.path })));

  rpc.onRequest("chat:createSession", async (params) => {
    const p = paramsOf(params);
    const projectName = requireString(p, "projectName");
    const providerId = requireString(p, "providerId");
    const project = getProjects().find((row) => row.name === projectName);
    if (!project) throw new Error(`Project "${projectName}" is not registered`);
    if (!providerRegistry.get(providerId)) throw new Error(`Provider "${providerId}" not found`);
    const session = await chatService.createSession(providerId, {
      projectName,
      projectPath: project.path,
      ...(typeof p.title === "string" && p.title ? { title: p.title } : {}),
    });
    // On record whatever the provider wrote: every later call finds the project through it.
    setSessionMetadata(session.id, projectName, project.path);
    if (typeof p.accountId === "string" && p.accountId) bindPickedAccount(session.id, session.providerId, p.accountId);
    // Stored like a pick made in the tab, so a turn the user types later runs on it too.
    if (typeof p.model === "string" && p.model) setSessionModel(session.id, p.model);
    return { sessionId: session.id, providerId: session.providerId, projectName, title: session.title };
  });

  rpc.onRequest("chat:send", async (params) => {
    const p = paramsOf(params);
    const { sessionId: _ignored, ...body } = p;
    const invalid = validateHeadlessSend(body);
    if (invalid) throw new Error(invalid);
    const { sessionId, providerId, projectPath } = resolveSession(requireString(p, "sessionId"));
    const { timeoutMs, notifyOnDone, ...payload } = body as ChatSendPayload & { timeoutMs?: number; notifyOnDone?: unknown };
    const { startHeadlessTurn } = await headlessTurn();
    const result = await startHeadlessTurn(sessionId, {
      ...payload,
      providerId,
      projectName: projectNameOf(projectPath),
      projectPath: projectPath ?? undefined,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      notifyOnDone: notifyOnDone === true,
    });
    return { sessionId, queued: result.queued };
  });

  rpc.onRequest("chat:cancel", async (params) => {
    const { sessionId, providerId } = resolveSession(requireString(paramsOf(params), "sessionId"));
    dbApprovalBroker.cancelSession(sessionId, "The extension stopped the turn before the user approved, so nothing ran.");
    chatService.abortQuery(providerId, sessionId, "extension_cancel", "extension");
    return { cancelled: true };
  });

  rpc.onRequest("chat:state", async (params) => {
    const { sessionId } = resolveSession(requireString(paramsOf(params), "sessionId"));
    const { getSessionTurnState } = await chatSocket();
    return getSessionTurnState(sessionId);
  });

  rpc.onRequest("chat:lastAssistantText", async (params) => {
    const { sessionId, providerId } = resolveSession(requireString(paramsOf(params), "sessionId"));
    const provider = providerRegistry.get(providerId);
    if (!provider?.getMessages) return null;
    const messages = await provider.getMessages(sessionId);
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.role === "assistant" && message.content) return message.content;
    }
    return null;
  });

  // The tab opens only in the browser that ran this extension's command just now: every
  // browser hears the broadcast, and a chat opened on each device at once was the bug.
  rpc.onRequest("chat:openTab", async (params) => {
    const p = paramsOf(params);
    const extensionId = requireString(p, "extensionId");
    const { sessionId, providerId, projectPath } = resolveSession(requireString(p, "sessionId"));
    const projectName = projectNameOf(projectPath);
    if (!projectName) throw new Error("The session's project is not registered");
    const clientId = recentCommandClient(extensionId);
    if (!clientId) return { opened: false };
    const title = chatService.getSession(sessionId)?.title || "Chat";
    broadcastExtMsg({
      type: "tab:open", tabType: "chat", title, projectId: projectName, closable: true, clientId,
      metadata: { projectName, sessionId, providerId },
    });
    return { opened: true };
  });
}
