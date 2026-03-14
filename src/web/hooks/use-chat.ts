import { useEffect, useRef, useState, useCallback } from "react";
import { WsClient } from "../lib/ws-client";
import type { ChatEvent } from "../../types/chat";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  event: ChatEvent | { type: "user_text"; content: string };
}

interface UseChatResult {
  messages: ChatMessage[];
  isStreaming: boolean;
  pendingApproval: { requestId: string; tool: string; input: unknown } | null;
  sendMessage: (content: string) => void;
  respondToApproval: (requestId: string, approved: boolean) => void;
  connected: boolean;
}

let _msgId = 0;
function nextId() {
  return `msg-${++_msgId}`;
}

export function useChat(sessionId: string): UseChatResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [connected, setConnected] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<{
    requestId: string;
    tool: string;
    input: unknown;
  } | null>(null);
  const wsRef = useRef<WsClient | null>(null);

  useEffect(() => {
    const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/chat/${sessionId}`;
    const ws = new WsClient(wsUrl);
    wsRef.current = ws;

    ws.onOpen(() => setConnected(true));
    ws.onClose(() => setConnected(false));

    ws.onMessage((evt) => {
      try {
        const event = JSON.parse(evt.data as string) as ChatEvent;

        if (event.type === "done") {
          setIsStreaming(false);
          return;
        }

        if (event.type === "error") {
          setIsStreaming(false);
        }

        if (event.type === "approval_request") {
          setPendingApproval({
            requestId: event.requestId,
            tool: event.tool,
            input: event.input,
          });
        }

        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "assistant", event },
        ]);
      } catch {
        // non-JSON frame, ignore
      }
    });

    ws.connect();

    return () => {
      ws.disconnect();
      wsRef.current = null;
    };
  }, [sessionId]);

  const sendMessage = useCallback((content: string) => {
    const ws = wsRef.current;
    if (!ws) return;
    ws.send(JSON.stringify({ type: "message", content }));
    setIsStreaming(true);
    setMessages((prev) => [
      ...prev,
      {
        id: nextId(),
        role: "user",
        event: { type: "user_text", content },
      },
    ]);
  }, []);

  const respondToApproval = useCallback((requestId: string, approved: boolean) => {
    const ws = wsRef.current;
    if (!ws) return;
    ws.send(JSON.stringify({ type: "approval_response", requestId, approved }));
    setPendingApproval(null);
  }, []);

  return { messages, isStreaming, pendingApproval, sendMessage, respondToApproval, connected };
}
