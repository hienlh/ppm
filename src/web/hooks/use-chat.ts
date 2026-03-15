import { useState, useCallback, useRef, useEffect } from "react";
import { useWebSocket } from "./use-websocket";
import { getAuthToken, projectUrl } from "@/lib/api-client";
import type { ChatMessage, ChatEvent, UsageInfo } from "../../types/chat";
import type { ChatWsServerMessage } from "../../types/api";

interface ApprovalRequest {
  requestId: string;
  tool: string;
  input: unknown;
}

interface UseChatReturn {
  messages: ChatMessage[];
  messagesLoading: boolean;
  isStreaming: boolean;
  pendingApproval: ApprovalRequest | null;
  usageInfo: UsageInfo;
  usageLoading: boolean;
  sendMessage: (content: string) => void;
  respondToApproval: (requestId: string, approved: boolean, data?: unknown) => void;
  cancelStreaming: () => void;
  refreshUsage: () => void;
  isConnected: boolean;
}

export function useChat(sessionId: string | null, providerId = "claude-sdk", projectName = ""): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [usageInfo, setUsageInfo] = useState<UsageInfo>({});
  const [usageLoading, setUsageLoading] = useState(false);
  const streamingContentRef = useRef("");
  const streamingEventsRef = useRef<ChatEvent[]>([]);
  const isStreamingRef = useRef(false);
  const pendingMessageRef = useRef<string | null>(null);
  const sendRef = useRef<(data: string) => void>(() => {});

  const handleMessage = useCallback((event: MessageEvent) => {
    let data: ChatWsServerMessage;
    try {
      data = JSON.parse(event.data as string) as ChatWsServerMessage;
    } catch {
      return;
    }

    // Ignore keepalive pings
    if ((data as any).type === "ping") return;

    // Handle connected event (custom, not in type)
    if ((data as any).type === "connected") {
      setIsConnected(true);
      return;
    }

    switch (data.type) {
      case "text": {
        streamingContentRef.current += data.content;
        streamingEventsRef.current.push(data);
        // Snapshot BEFORE queueing setState — React 18 batching may delay updater execution
        const txtContent = streamingContentRef.current;
        const txtEvents = [...streamingEventsRef.current];
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant" && !last.id.startsWith("final-")) {
            return [
              ...prev.slice(0, -1),
              { ...last, content: txtContent, events: txtEvents },
            ];
          }
          return [
            ...prev,
            {
              id: `streaming-${Date.now()}`,
              role: "assistant" as const,
              content: txtContent,
              events: txtEvents,
              timestamp: new Date().toISOString(),
            },
          ];
        });
        break;
      }

      case "tool_use": {
        streamingEventsRef.current.push(data);
        const tuContent = streamingContentRef.current;
        const tuEvents = [...streamingEventsRef.current];
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [
              ...prev.slice(0, -1),
              { ...last, events: tuEvents },
            ];
          }
          return [
            ...prev,
            {
              id: `streaming-${Date.now()}`,
              role: "assistant" as const,
              content: tuContent,
              events: tuEvents,
              timestamp: new Date().toISOString(),
            },
          ];
        });
        break;
      }

      case "tool_result": {
        streamingEventsRef.current.push(data);
        const trEvents = [...streamingEventsRef.current];
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [
              ...prev.slice(0, -1),
              { ...last, events: trEvents },
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

      case "usage": {
        // Merge usage info — accumulate totalCostUsd, track queryCostUsd
        setUsageInfo((prev) => {
          const next = { ...prev, ...data.usage };
          if (data.usage.totalCostUsd != null) {
            next.queryCostUsd = data.usage.totalCostUsd;
            next.totalCostUsd = (prev.totalCostUsd ?? 0) + data.usage.totalCostUsd;
          }
          return next;
        });
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

        // Flush queued message if user typed while streaming
        const queued = pendingMessageRef.current;
        if (queued) {
          pendingMessageRef.current = null;
          // Add user message to list
          setMessages((prev2) => [
            ...prev2,
            {
              id: `user-${Date.now()}`,
              role: "user" as const,
              content: queued,
              timestamp: new Date().toISOString(),
            },
          ]);
          streamingContentRef.current = "";
          streamingEventsRef.current = [];
          isStreamingRef.current = true;
          setIsStreaming(true);
          sendRef.current(JSON.stringify({ type: "message", content: queued }));
        } else {
          isStreamingRef.current = false;
          setIsStreaming(false);
        }
        break;
      }
    }
  }, []);

  const wsUrl = sessionId && projectName
    ? `/ws/project/${encodeURIComponent(projectName)}/chat/${sessionId}`
    : "";

  const { send } = useWebSocket({
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

    if (projectName) {
      // Load cached usage/rate-limit info immediately
      fetch(`${projectUrl(projectName)}/chat/usage?providerId=${providerId}`, {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      })
        .then((r) => r.json())
        .then((json: any) => {
          if (!cancelled && json.ok && json.data) {
            setUsageInfo((prev) => ({ ...prev, ...json.data }));
          }
        })
        .catch(() => {});
    }

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

      // If streaming, queue message to send after current stream finishes
      if (isStreaming) {
        pendingMessageRef.current = content;
        return;
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
      isStreamingRef.current = true;
      setIsStreaming(true);

      send(JSON.stringify({ type: "message", content }));
    },
    [send, isStreaming],
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

  const refreshUsage = useCallback(() => {
    if (!projectName) return;
    setUsageLoading(true);
    fetch(`${projectUrl(projectName)}/chat/usage?providerId=${providerId}&_t=${Date.now()}`, {
      headers: { Authorization: `Bearer ${getAuthToken()}` },
    })
      .then((r) => r.json())
      .then((json: any) => {
        if (json.ok && json.data) {
          setUsageInfo((prev) => ({ ...prev, ...json.data }));
        }
      })
      .catch(() => {})
      .finally(() => setUsageLoading(false));
  }, [projectName, providerId]);

  return {
    messages,
    messagesLoading,
    isStreaming,
    pendingApproval,
    usageInfo,
    usageLoading,
    sendMessage,
    respondToApproval,
    cancelStreaming,
    refreshUsage,
    isConnected,
  };
}
