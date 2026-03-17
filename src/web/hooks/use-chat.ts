import { useState, useCallback, useRef, useEffect } from "react";
import { useWebSocket } from "./use-websocket";
import { getAuthToken, projectUrl } from "@/lib/api-client";
import type { ChatMessage, ChatEvent, UsageInfo } from "../../types/chat";
import type { ChatWsServerMessage } from "../../types/api";

/** Callback to forward WS usage events to the external useUsage hook */
export type UsageEventCallback = (usage: Partial<UsageInfo>) => void;

interface ApprovalRequest {
  requestId: string;
  tool: string;
  input: unknown;
}

interface UseChatOptions {
  onUsageEvent?: UsageEventCallback;
}

/** Streaming phase: connecting → streaming → idle */
export type StreamingStatus = "idle" | "connecting" | "streaming";

interface UseChatReturn {
  messages: ChatMessage[];
  messagesLoading: boolean;
  isStreaming: boolean;
  streamingStatus: StreamingStatus;
  pendingApproval: ApprovalRequest | null;
  sendMessage: (content: string) => void;
  respondToApproval: (requestId: string, approved: boolean, data?: unknown) => void;
  cancelStreaming: () => void;
  reconnect: () => void;
  refetchMessages: () => void;
  isConnected: boolean;
}

export function useChat(sessionId: string | null, providerId = "claude-sdk", projectName = "", options?: UseChatOptions): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingStatus, setStreamingStatus] = useState<StreamingStatus>("idle");
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const onUsageEventRef = useRef(options?.onUsageEvent);
  onUsageEventRef.current = options?.onUsageEvent;
  const streamingContentRef = useRef("");
  const streamingEventsRef = useRef<ChatEvent[]>([]);
  const isStreamingRef = useRef(false);
  const pendingMessageRef = useRef<string | null>(null);
  const sendRef = useRef<(data: string) => void>(() => {});
  const refetchRef = useRef<(() => void) | null>(null);

  const handleMessage = useCallback((event: MessageEvent) => {
    let data: ChatWsServerMessage;
    try {
      data = JSON.parse(event.data as string) as ChatWsServerMessage;
    } catch {
      return;
    }

    // Ignore keepalive pings
    if ((data as any).type === "ping") return;

    // Handle streaming status updates (connecting → streaming → idle)
    if ((data as any).type === "streaming_status") {
      setStreamingStatus((data as any).status ?? "idle");
      return;
    }

    // Handle connected event (new session)
    if ((data as any).type === "connected") {
      setIsConnected(true);
      return;
    }

    // Handle status event (FE reconnected to existing session)
    if ((data as any).type === "status") {
      setIsConnected(true);
      const status = data as any;
      if (status.isStreaming) {
        isStreamingRef.current = true;
        setIsStreaming(true);
      }
      if (status.pendingApproval) {
        setPendingApproval({
          requestId: status.pendingApproval.requestId,
          tool: status.pendingApproval.tool,
          input: status.pendingApproval.input,
        });
      }
      // Refetch history to catch up on events missed during disconnect
      refetchRef.current?.();
      return;
    }

    /**
     * Route a child event to its parent Agent/Task tool_use's children array.
     * Returns true if routed (caller should skip flat append), false if no parent found.
     */
    const routeToParent = (childEvent: ChatEvent, parentToolUseId: string): boolean => {
      const parent = streamingEventsRef.current.find(
        (e) => e.type === "tool_use"
          && (e.tool === "Agent" || e.tool === "Task")
          && (e as any).toolUseId === parentToolUseId,
      );
      if (parent && parent.type === "tool_use") {
        if (!parent.children) parent.children = [];
        parent.children.push(childEvent);
        return true;
      }
      return false;
    };

    /** Trigger re-render with latest events snapshot */
    const syncMessages = () => {
      const content = streamingContentRef.current;
      const events = [...streamingEventsRef.current];
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && !last.id.startsWith("final-")) {
          return [...prev.slice(0, -1), { ...last, content, events }];
        }
        return [...prev, {
          id: `streaming-${Date.now()}`,
          role: "assistant" as const,
          content,
          events,
          timestamp: new Date().toISOString(),
        }];
      });
    };

    switch (data.type) {
      case "text": {
        const pid = (data as any).parentToolUseId as string | undefined;
        if (pid && routeToParent(data, pid)) {
          // Child text routed to parent — just re-render
          syncMessages();
          break;
        }
        streamingContentRef.current += data.content;
        streamingEventsRef.current.push(data);
        syncMessages();
        break;
      }

      case "tool_use": {
        const pid = (data as any).parentToolUseId as string | undefined;
        if (pid && routeToParent(data, pid)) {
          syncMessages();
          break;
        }
        streamingEventsRef.current.push(data);
        syncMessages();
        break;
      }

      case "tool_result": {
        const pid = (data as any).parentToolUseId as string | undefined;
        if (pid && routeToParent(data, pid)) {
          syncMessages();
          break;
        }
        streamingEventsRef.current.push(data);
        syncMessages();
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

      case "usage": {
        // Forward to external usage hook
        onUsageEventRef.current?.(data.usage);
        break;
      }

      case "error": {
        streamingEventsRef.current.push(data);
        const errEvents = [...streamingEventsRef.current];
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [
              ...prev.slice(0, -1),
              { ...last, events: errEvents },
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
        isStreamingRef.current = false;
        setIsStreaming(false);
        setStreamingStatus("idle");
        break;
      }

      case "done": {
        // Finalize the streaming message — capture refs before clearing
        const finalContent = streamingContentRef.current;
        const finalEvents = [...streamingEventsRef.current];
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [
              ...prev.slice(0, -1),
              {
                ...last,
                id: `final-${Date.now()}`,
                content: finalContent || last.content,
                events: finalEvents.length > 0 ? finalEvents : last.events,
              },
            ];
          }
          return prev;
        });
        streamingContentRef.current = "";
        streamingEventsRef.current = [];
        isStreamingRef.current = false;
        setIsStreaming(false);
        setStreamingStatus("idle");
        break;
      }
    }
  }, []);

  const wsUrl = sessionId && projectName
    ? `/ws/project/${encodeURIComponent(projectName)}/chat/${sessionId}`
    : "";

  const { send, connect: wsReconnect } = useWebSocket({
    url: wsUrl,
    onMessage: handleMessage,
    autoConnect: !!sessionId && !!projectName,
  });

  // Keep sendRef in sync so handleMessage can flush queued messages
  sendRef.current = send;

  // Load history and reset state when session changes
  useEffect(() => {
    let cancelled = false;

    setIsStreaming(false);
    setPendingApproval(null);
    streamingContentRef.current = "";
    streamingEventsRef.current = [];
    setIsConnected(false);

    if (sessionId && projectName) {
      // Load message history
      setMessagesLoading(true);
      fetch(`${projectUrl(projectName)}/chat/sessions/${sessionId}/messages?providerId=${providerId}`, {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      })
        .then((r) => r.json())
        .then((json: any) => {
          if (cancelled || isStreamingRef.current) return;
          if (json.ok && Array.isArray(json.data) && json.data.length > 0) {
            setMessages(json.data);
          } else {
            setMessages([]);
          }
        })
        .catch(() => {
          if (!cancelled && !isStreamingRef.current) setMessages([]);
        })
        .finally(() => {
          if (!cancelled) setMessagesLoading(false);
        });
    } else {
      setMessages([]);
    }

    return () => {
      cancelled = true;
    };
  }, [sessionId, providerId, projectName]);

  const sendMessage = useCallback(
    (content: string) => {
      if (!content.trim()) return;

      // If streaming, cancel current stream first then send immediately
      if (isStreamingRef.current) {
        // Finalize current streaming message
        const finalContent = streamingContentRef.current;
        const finalEvents = [...streamingEventsRef.current];
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [
              ...prev.slice(0, -1),
              { ...last, id: `final-${Date.now()}`, content: finalContent || last.content, events: finalEvents.length > 0 ? finalEvents : last.events },
            ];
          }
          return prev;
        });
        // Tell backend to abort current query
        send(JSON.stringify({ type: "cancel" }));
      }

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
      pendingMessageRef.current = null;
      isStreamingRef.current = true;
      setIsStreaming(true);
      setStreamingStatus("connecting");
      setPendingApproval(null);

      send(JSON.stringify({ type: "message", content }));
    },
    [send],
  );

  const respondToApproval = useCallback(
    (requestId: string, approved: boolean, data?: unknown) => {
      send(
        JSON.stringify({
          type: "approval_response",
          requestId,
          approved,
          data,
        }),
      );

      // Merge answers into the AskUserQuestion tool_use event so FE shows selected answers
      if (approved && data) {
        const evts = streamingEventsRef.current;
        const askEvt = evts.find(
          (e: ChatEvent) =>
            e.type === "approval_request" &&
            (e as any).requestId === requestId &&
            (e as any).tool === "AskUserQuestion",
        );
        if (askEvt) {
          // Mutate input to include answers — this updates the rendered ToolCard
          const inp = (askEvt as any).input;
          if (inp && typeof inp === "object") {
            (inp as Record<string, unknown>).answers = data;
          }
        }
        // Force re-render messages
        setMessages((prev) => [...prev]);
      }

      setPendingApproval(null);
    },
    [send],
  );

  const cancelStreaming = useCallback(() => {
    if (!isStreamingRef.current) return;
    // Tell backend to abort
    send(JSON.stringify({ type: "cancel" }));
    // Finalize current message on FE
    const finalContent = streamingContentRef.current;
    const finalEvents = [...streamingEventsRef.current];
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant") {
        return [
          ...prev.slice(0, -1),
          {
            ...last,
            id: `final-${Date.now()}`,
            content: finalContent || last.content,
            events: finalEvents.length > 0 ? finalEvents : last.events,
          },
        ];
      }
      return prev;
    });
    streamingContentRef.current = "";
    streamingEventsRef.current = [];
    pendingMessageRef.current = null;
    isStreamingRef.current = false;
    setIsStreaming(false);
    setPendingApproval(null);
  }, [send]);

  const reconnect = useCallback(() => {
    setIsConnected(false);
    wsReconnect();
    // Refetch history on manual reconnect to catch up on missed events
    refetchRef.current?.();
  }, [wsReconnect]);

  const refetchMessages = useCallback(() => {
    if (!sessionId || !projectName) return;
    setMessagesLoading(true);
    fetch(`${projectUrl(projectName)}/chat/sessions/${sessionId}/messages?providerId=${providerId}`, {
      headers: { Authorization: `Bearer ${getAuthToken()}` },
    })
      .then((r) => r.json())
      .then((json: any) => {
        if (json.ok && Array.isArray(json.data) && json.data.length > 0) {
          setMessages(json.data);
          // Reset streaming content refs so live tokens append cleanly after history
          streamingContentRef.current = "";
          streamingEventsRef.current = [];
        }
      })
      .catch(() => {})
      .finally(() => setMessagesLoading(false));
  }, [sessionId, providerId, projectName]);

  // Keep refetchRef in sync so handleMessage (status event) can trigger refetch
  refetchRef.current = refetchMessages;

  return {
    messages,
    messagesLoading,
    isStreaming,
    streamingStatus,
    pendingApproval,
    sendMessage,
    respondToApproval,
    cancelStreaming,
    reconnect,
    refetchMessages,
    isConnected,
  };
}
