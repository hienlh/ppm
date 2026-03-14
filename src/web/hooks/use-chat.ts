import { useState, useCallback, useRef, useEffect } from "react";
import { useWebSocket } from "./use-websocket";
import type { ChatMessage, ChatEvent } from "../../types/chat";
import type { ChatWsServerMessage } from "../../types/api";

interface ApprovalRequest {
  requestId: string;
  tool: string;
  input: unknown;
}

interface UseChatReturn {
  messages: ChatMessage[];
  isStreaming: boolean;
  pendingApproval: ApprovalRequest | null;
  sendMessage: (content: string) => void;
  respondToApproval: (requestId: string, approved: boolean, reason?: string) => void;
  isConnected: boolean;
}

export function useChat(sessionId: string | null): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const streamingContentRef = useRef("");
  const streamingEventsRef = useRef<ChatEvent[]>([]);

  const handleMessage = useCallback((event: MessageEvent) => {
    let data: ChatWsServerMessage;
    try {
      data = JSON.parse(event.data as string) as ChatWsServerMessage;
    } catch {
      return;
    }

    // Handle connected event (custom, not in type)
    if ((data as any).type === "connected") {
      setIsConnected(true);
      return;
    }

    switch (data.type) {
      case "text": {
        streamingContentRef.current += data.content;
        streamingEventsRef.current.push(data);
        // Update or create assistant message
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant" && !last.id.startsWith("final-")) {
            return [
              ...prev.slice(0, -1),
              { ...last, content: streamingContentRef.current, events: [...streamingEventsRef.current] },
            ];
          }
          return [
            ...prev,
            {
              id: `streaming-${Date.now()}`,
              role: "assistant" as const,
              content: streamingContentRef.current,
              events: [...streamingEventsRef.current],
              timestamp: new Date().toISOString(),
            },
          ];
        });
        break;
      }

      case "tool_use": {
        streamingEventsRef.current.push(data);
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [
              ...prev.slice(0, -1),
              { ...last, events: [...streamingEventsRef.current] },
            ];
          }
          return [
            ...prev,
            {
              id: `streaming-${Date.now()}`,
              role: "assistant" as const,
              content: streamingContentRef.current,
              events: [...streamingEventsRef.current],
              timestamp: new Date().toISOString(),
            },
          ];
        });
        break;
      }

      case "tool_result": {
        streamingEventsRef.current.push(data);
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [
              ...prev.slice(0, -1),
              { ...last, events: [...streamingEventsRef.current] },
            ];
          }
          return prev;
        });
        break;
      }

      case "approval_request": {
        streamingEventsRef.current.push(data);
        setPendingApproval({
          requestId: data.requestId,
          tool: data.tool,
          input: data.input,
        });
        break;
      }

      case "error": {
        streamingEventsRef.current.push(data);
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [
              ...prev.slice(0, -1),
              { ...last, events: [...streamingEventsRef.current] },
            ];
          }
          return [
            ...prev,
            {
              id: `error-${Date.now()}`,
              role: "system" as const,
              content: data.message,
              events: [data],
              timestamp: new Date().toISOString(),
            },
          ];
        });
        setIsStreaming(false);
        break;
      }

      case "done": {
        // Finalize the streaming message
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [
              ...prev.slice(0, -1),
              { ...last, id: `final-${Date.now()}` },
            ];
          }
          return prev;
        });
        streamingContentRef.current = "";
        streamingEventsRef.current = [];
        setIsStreaming(false);
        break;
      }
    }
  }, []);

  const { send } = useWebSocket({
    url: sessionId ? `/ws/chat/${sessionId}` : "",
    onMessage: handleMessage,
    autoConnect: !!sessionId,
  });

  // Reset state when session changes
  useEffect(() => {
    setMessages([]);
    setIsStreaming(false);
    setPendingApproval(null);
    streamingContentRef.current = "";
    streamingEventsRef.current = [];
    setIsConnected(false);
  }, [sessionId]);

  const sendMessage = useCallback(
    (content: string) => {
      if (!content.trim() || isStreaming) return;

      // Add user message
      setMessages((prev) => [
        ...prev,
        {
          id: `user-${Date.now()}`,
          role: "user" as const,
          content,
          timestamp: new Date().toISOString(),
        },
      ]);

      // Reset streaming state
      streamingContentRef.current = "";
      streamingEventsRef.current = [];
      setIsStreaming(true);

      send(JSON.stringify({ type: "message", content }));
    },
    [send, isStreaming],
  );

  const respondToApproval = useCallback(
    (requestId: string, approved: boolean, reason?: string) => {
      send(
        JSON.stringify({
          type: "approval_response",
          requestId,
          approved,
          reason,
        }),
      );
      setPendingApproval(null);
    },
    [send],
  );

  return {
    messages,
    isStreaming,
    pendingApproval,
    sendMessage,
    respondToApproval,
    isConnected,
  };
}
