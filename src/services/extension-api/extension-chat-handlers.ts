/**
 * `ppm.chat.*` — an extension drives a chat session with nobody watching: creates one in a
 * registered project, sends turns, cancels, polls the state, reads the last answer and opens
 * the chat as a tab in the browser that ran its command. Every turn goes through
 * `startHeadlessTurn`, so it runs on the same consumer a tab's turn does.
 */
import type { RpcChannel } from "../extension-rpc.ts";
import { chatService } from "../chat.service.ts";
import { providerRegistry } from "../../providers/registry.ts";
import { getProjects, getSessionCreatedByExtension, getSessionProjectPath, getSessionProvider, resolveMigratedSession, setSessionCreatedByExtension, setSessionMetadata, setSessionModel } from "../db.service.ts";
import { bindPickedAccount } from "../picked-account-binding.ts";
import { BINDING_CLAUDE_ONLY, createBindableSession, providerSupportsBinding } from "../extension-session-binding.service.ts";
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

/**
 * A session an extension may drive or stop: one it created itself. Every extension shares
 * the host, so the id is what the worker says it is — this confines a mistaken extension
 * to its own sessions, and keeps a person's chats out of reach of a loop gone wrong.
 */
function resolveOwnSession(requestedId: string, extensionId: string): ReturnType<typeof resolveSession> {
  const resolved = resolveSession(requestedId);
  if (getSessionCreatedByExtension(resolved.sessionId) !== extensionId) {
    throw new Error("Session was not created by this extension");
  }
  return resolved;
}

function projectNameOf(projectPath: string | null): string | undefined {
  if (!projectPath) return undefined;
  return getProjects().find((p) => p.path === projectPath)?.name;
}

export function registerExtensionChatHandlers(rpc: RpcChannel): void {
  rpc.onRequest("chat:listProjects", async () => getProjects().map((p) => ({ name: p.name, path: p.path })));

  rpc.onRequest("chat:createSession", async (params) => {
    const p = paramsOf(params);
    const extensionId = requireString(p, "extensionId");
    const projectName = requireString(p, "projectName");
    const providerId = requireString(p, "providerId");
    const project = getProjects().find((row) => row.name === projectName);
    if (!project) throw new Error(`Project "${projectName}" is not registered`);
    if (!providerRegistry.get(providerId)) throw new Error(`Provider "${providerId}" not found`);
    if (p.bindable !== undefined && typeof p.bindable !== "boolean") throw new Error("bindable must be a boolean");
    // Checked before the session exists, so a refusal leaves nothing behind.
    if (p.bindable && !providerSupportsBinding(providerId)) throw new Error(BINDING_CLAUDE_ONLY);
    const session = await chatService.createSession(providerId, {
      projectName,
      projectPath: project.path,
      ...(typeof p.title === "string" && p.title ? { title: p.title } : {}),
    });
    // On record whatever the provider wrote: every later call finds the project through it.
    setSessionMetadata(session.id, projectName, project.path);
    setSessionCreatedByExtension(session.id, extensionId);
    if (p.bindable) createBindableSession(session.id, extensionId);
    if (typeof p.accountId === "string" && p.accountId) bindPickedAccount(session.id, session.providerId, p.accountId);
    // Stored like a pick made in the tab, so a turn the user types later runs on it too.
    if (typeof p.model === "string" && p.model) setSessionModel(session.id, p.model);
    return { sessionId: session.id, providerId: session.providerId, projectName, title: session.title };
  });

  rpc.onRequest("chat:send", async (params) => {
    const p = paramsOf(params);
    const { sessionId: _ignored, extensionId: _ext, ...body } = p;
    const extensionId = requireString(p, "extensionId");
    const invalid = validateHeadlessSend(body);
    if (invalid) throw new Error(invalid);
    const { sessionId, providerId, projectPath } = resolveOwnSession(requireString(p, "sessionId"), extensionId);
    const { timeoutMs, notifyOnDone, ...payload } = body as ChatSendPayload & { timeoutMs?: number; notifyOnDone?: unknown };
    const { startHeadlessTurn } = await headlessTurn();
    const result = await startHeadlessTurn(sessionId, {
      ...payload,
      providerId,
      projectName: projectNameOf(projectPath),
      projectPath: projectPath ?? undefined,
      extensionId,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      notifyOnDone: notifyOnDone === true,
    });
    return { sessionId, queued: result.queued };
  });

  rpc.onRequest("chat:cancel", async (params) => {
    const p = paramsOf(params);
    const { sessionId, providerId } = resolveOwnSession(requireString(p, "sessionId"), requireString(p, "extensionId"));
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
