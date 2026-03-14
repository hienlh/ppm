import type { ServerWebSocket } from "bun";
import type { ChatService } from "../../services/chat.service.ts";

type ClientMessage =
  | { type: "message"; content: string }
  | { type: "approval_response"; requestId: string; approved: boolean };

interface PendingApproval {
  resolve: (approved: boolean) => void;
}

export interface ChatWsData {
  kind: "chat";
  sessionId: string;
  chatService: ChatService;
  pendingApprovals: Map<string, PendingApproval>;
}

export const chatWsHandlers = {
  open(ws: ServerWebSocket<ChatWsData>) {
    ws.send(JSON.stringify({ type: "connected", sessionId: ws.data.sessionId }));
  },

  async message(ws: ServerWebSocket<ChatWsData>, raw: string | Buffer) {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    let msg: ClientMessage;
    try {
      msg = JSON.parse(text) as ClientMessage;
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    if (msg.type === "approval_response") {
      const pending = ws.data.pendingApprovals.get(msg.requestId);
      if (pending) {
        ws.data.pendingApprovals.delete(msg.requestId);
        pending.resolve(msg.approved);
      }
      return;
    }

    if (msg.type === "message") {
      const { sessionId, chatService } = ws.data;

      const provider = chatService.getRegistry().getDefault();
      if (provider.onToolApproval) {
        provider.onToolApproval(async (req) => {
          ws.send(JSON.stringify({
            type: "approval_request",
            requestId: req.requestId,
            tool: req.tool,
            input: req.input,
          }));
          return new Promise<boolean>((resolve) => {
            ws.data.pendingApprovals.set(req.requestId, { resolve });
          });
        });
      }

      try {
        const stream = chatService.sendMessage(sessionId, msg.content);
        for await (const event of stream) {
          if (ws.readyState !== 1 /* OPEN */) break;
          ws.send(JSON.stringify(event));
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", message: String(err) }));
      }
    }
  },

  close(ws: ServerWebSocket<ChatWsData>) {
    for (const [, pending] of ws.data.pendingApprovals) {
      pending.resolve(false);
    }
    ws.data.pendingApprovals.clear();
  },
};
