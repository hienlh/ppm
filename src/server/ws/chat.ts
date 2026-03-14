import { chatService } from "../../services/chat.service.ts";
import { providerRegistry } from "../../providers/registry.ts";
import type { ChatWsClientMessage } from "../../types/api.ts";

/** Tracks active chat WS connections: sessionId -> ws */
const activeSessions = new Map<
  string,
  { providerId: string; ws: ChatWsSocket }
>();

type ChatWsSocket = {
  data: { type: string; sessionId: string };
  send: (data: string) => void;
};

/**
 * Chat WebSocket handler for Bun.serve().
 * Protocol: JSON messages as defined in ChatWsClientMessage / ChatWsServerMessage.
 */
export const chatWebSocket = {
  open(ws: ChatWsSocket) {
    const { sessionId } = ws.data;
    // Look up session's actual provider, default to "claude-sdk"
    const session = chatService.getSession(sessionId);
    const providerId = session?.providerId ?? "claude-sdk";
    activeSessions.set(sessionId, { providerId, ws });
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
      try {
        for await (const event of chatService.sendMessage(
          providerId,
          sessionId,
          parsed.content,
        )) {
          ws.send(JSON.stringify(event));
        }
      } catch (e) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: (e as Error).message,
          }),
        );
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
    activeSessions.delete(sessionId);
  },
};
