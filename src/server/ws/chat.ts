import { chatService } from "../../services/chat.service.ts";
import { providerRegistry } from "../../providers/registry.ts";
import { resolveProjectPath } from "../helpers/resolve-project.ts";
import type { ChatWsClientMessage } from "../../types/api.ts";

/** Tracks active chat WS connections: sessionId -> ws + abort controller + project context */
const activeSessions = new Map<
  string,
  { providerId: string; ws: ChatWsSocket; abort?: AbortController; projectPath?: string }
>();

type ChatWsSocket = {
  data: { type: string; sessionId: string; projectName?: string };
  send: (data: string) => void;
};

/**
 * Chat WebSocket handler for Bun.serve().
 * Protocol: JSON messages as defined in ChatWsClientMessage / ChatWsServerMessage.
 */
export const chatWebSocket = {
  open(ws: ChatWsSocket) {
    const { sessionId, projectName } = ws.data;
    // Look up session's actual provider, default to "claude-sdk"
    const session = chatService.getSession(sessionId);
    const providerId = session?.providerId ?? "claude-sdk";

    // Resolve projectPath for skills/settings support
    let projectPath: string | undefined;
    if (projectName) {
      try { projectPath = resolveProjectPath(projectName); } catch { /* ignore */ }
    }

    // Backfill projectPath on existing session
    if (session && !session.projectPath && projectPath) {
      session.projectPath = projectPath;
    }

    activeSessions.set(sessionId, { providerId, ws, projectPath });
    ws.send(JSON.stringify({ type: "connected", sessionId }));
  },

  async message(ws: ChatWsSocket, msg: string | ArrayBuffer | Uint8Array) {
    const { sessionId } = ws.data;
    const text =
      typeof msg === "string" ? msg : new TextDecoder().decode(msg as ArrayBuffer);

    let parsed: ChatWsClientMessage;
    try {
      parsed = JSON.parse(text) as ChatWsClientMessage;
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    const entry = activeSessions.get(sessionId);
    const providerId = entry?.providerId ?? "mock";

    if (parsed.type === "message") {
      // Ensure provider session has projectPath for skills/settings support
      if (entry?.projectPath) {
        const provider = providerRegistry.get(providerId);
        if (provider && "ensureProjectPath" in provider) {
          (provider as any).ensureProjectPath(sessionId, entry.projectPath);
        }
      }

      const abortController = new AbortController();
      const entryRef = activeSessions.get(sessionId);
      if (entryRef) entryRef.abort = abortController;

      try {
        for await (const event of chatService.sendMessage(
          providerId,
          sessionId,
          parsed.content,
        )) {
          if (abortController.signal.aborted) break;
          ws.send(JSON.stringify(event));
        }
      } catch (e) {
        if (!abortController.signal.aborted) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: (e as Error).message,
            }),
          );
        }
      } finally {
        if (entryRef) entryRef.abort = undefined;
      }
    } else if (parsed.type === "cancel") {
      // Only abort the underlying SDK query — don't break the for-await loop.
      // This lets Claude send its final message before the iterator ends naturally.
      const provider = providerRegistry.get(providerId);
      if (provider && "abortQuery" in provider && typeof (provider as any).abortQuery === "function") {
        (provider as any).abortQuery(sessionId);
      }
    } else if (parsed.type === "approval_response") {
      // Route approval response to the provider
      const provider = providerRegistry.get(providerId);
      if (provider && typeof provider.resolveApproval === "function") {
        provider.resolveApproval(
          parsed.requestId,
          parsed.approved,
          (parsed as any).data,
        );
      }
    }
  },

  close(ws: ChatWsSocket) {
    const { sessionId } = ws.data;
    const entry = activeSessions.get(sessionId);
    if (entry) {
      // Force-break the for-await loop — no client to receive events anymore
      if (entry.abort) {
        entry.abort.abort();
        entry.abort = undefined;
      }
      // Also abort the underlying SDK query so Claude stops working
      const provider = providerRegistry.get(entry.providerId);
      if (provider && "abortQuery" in provider && typeof (provider as any).abortQuery === "function") {
        (provider as any).abortQuery(sessionId);
      }
    }
    activeSessions.delete(sessionId);
  },
};
