import { useState, useCallback, useRef, useEffect } from "react";
import { useWebSocket } from "./use-websocket";
import { api, getAuthToken, projectUrl } from "@/lib/api-client";
import { useNotificationStore } from "@/stores/notification-store";
import { usePanelStore } from "@/stores/panel-store";
import { playNotificationSound } from "@/lib/notification-sounds";
import type { ChatMessage, ChatEvent } from "../../types/chat";
import type { ChatWsServerMessage, SessionPhase } from "../../types/api";

interface ApprovalRequest {
  requestId: string;
  tool: string;
  input: unknown;
}

export interface TeamMessageItem {
  from: string;
  to: string;
  text: string;
  timestamp: string;
  summary?: string;
  parsedType?: string;
  color?: string;
}

interface TeamActivityState {
  hasTeams: boolean;
  teamNames: string[];
  messageCount: number;
  unreadCount: number;
}

const EMPTY_TEAM_ACTIVITY: TeamActivityState = { hasTeams: false, teamNames: [], messageCount: 0, unreadCount: 0 };

interface UseChatReturn {
  messages: ChatMessage[];
  messagesLoading: boolean;
  isStreaming: boolean;
  phase: SessionPhase;
  isReconnecting: boolean;
  connectingElapsed: number;
  pendingApproval: ApprovalRequest | null;
  contextWindowPct: number | null;
  compactStatus: "compacting" | null;
  statusMessage: string | null;
  sessionTitle: string | null;
  /** When CLI provider assigns a different session ID, this holds the new ID */
  migratedSessionId: string | null;
  /** Team activity state from WS events */
  teamActivity: TeamActivityState;
  /** All team messages (ref-backed, updated live) */
  teamMessages: TeamMessageItem[];
  /** Mark team messages as read (reset unread counter) */
  markTeamRead: () => void;
  sendMessage: (content: string, opts?: { permissionMode?: string; priority?: 'now' | 'next' | 'later'; images?: Array<{ data: string; mediaType: string }> }) => void;
  respondToApproval: (requestId: string, approved: boolean, data?: unknown) => void;
  cancelStreaming: () => void;
  reconnect: () => void;
  refetchMessages: () => void;
  isConnected: boolean;
}

/** Check if the chat tab for this session is the active foreground tab */
function isSessionTabActive(sid: string): boolean {
  if (document.hidden) return false;
  const { panels, focusedPanelId } = usePanelStore.getState();
  const panel = panels[focusedPanelId];
  if (!panel) return false;
  const activeTab = panel.tabs.find((t) => t.id === panel.activeTabId);
  return activeTab?.type === "chat" && activeTab.metadata?.sessionId === sid;
}

export function useChat(sessionId: string | null, providerId = "claude", projectName = ""): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [phase, setPhase] = useState<SessionPhase>("idle");
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [connectingElapsed, setConnectingElapsed] = useState(0);
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  const [contextWindowPct, setContextWindowPct] = useState<number | null>(null);
  const [compactStatus, setCompactStatus] = useState<"compacting" | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [migratedSessionId, setMigratedSessionId] = useState<string | null>(null);
  const streamingContentRef = useRef("");
  const streamingEventsRef = useRef<ChatEvent[]>([]);
  const streamingAccountRef = useRef<{ accountId: string; accountLabel: string } | null>(null);
  const phaseRef = useRef<SessionPhase>("idle");
  const pendingMessageRef = useRef<string | null>(null);
  const sendRef = useRef<(data: string) => void>(() => {});
  const refetchRef = useRef<(() => void) | null>(null);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const projectNameRef = useRef(projectName);
  projectNameRef.current = projectName;

  // Team activity tracking
  const teamActivityRef = useRef<{
    teamNames: Set<string>;
    messages: TeamMessageItem[];
  }>({ teamNames: new Set(), messages: [] });
  const teamUnreadRef = useRef(0);
  const [teamActivity, setTeamActivity] = useState<TeamActivityState>(EMPTY_TEAM_ACTIVITY);
  const [teamMessages, setTeamMessages] = useState<TeamMessageItem[]>([]);

  const updateTeamActivity = useCallback(() => {
    const ref = teamActivityRef.current;
    setTeamActivity({
      hasTeams: ref.teamNames.size > 0,
      teamNames: Array.from(ref.teamNames),
      messageCount: ref.messages.length,
      unreadCount: teamUnreadRef.current,
    });
    // Snapshot messages array so React detects changes
    setTeamMessages([...ref.messages]);
  }, []);

  const markTeamRead = useCallback(() => {
    teamUnreadRef.current = 0;
    updateTeamActivity();
  }, [updateTeamActivity]);

  // Derived state
  const isStreaming = phase !== "idle";

  /**
   * Route a child event to its parent Agent/Task tool_use's children array.
   * Creates a new parent object to ensure React detects the change on re-render.
   * Returns true if routed (caller should skip flat append), false if no parent found.
   */
  const routeToParent = useCallback((childEvent: ChatEvent, parentToolUseId: string): boolean => {
    const idx = streamingEventsRef.current.findIndex(
      (e) => e.type === "tool_use"
        && (e.tool === "Agent" || e.tool === "Task")
        && (e as any).toolUseId === parentToolUseId,
    );
    if (idx === -1) return false;
    const parent = streamingEventsRef.current[idx]!;
    if (parent.type !== "tool_use") return false;
    const newChildren = [...(parent.children ?? []), childEvent];
    streamingEventsRef.current[idx] = { ...parent, children: newChildren };
    return true;
  }, []);

  /** Trigger re-render with latest events snapshot */
  const syncMessages = useCallback(() => {
    const content = streamingContentRef.current;
    const events = [...streamingEventsRef.current];
    const account = streamingAccountRef.current;
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant" && !last.id.startsWith("final-")) {
        return [...prev.slice(0, -1), { ...last, content, events, ...account }];
      }
      return [...prev, {
        id: `streaming-${Date.now()}`,
        role: "assistant" as const,
        content,
        events,
        timestamp: new Date().toISOString(),
        ...account,
      }];
    });
  }, []);

  /** Process a single stream event — reused by live events and turn_events replay */
  const processStreamEvent = useCallback((data: unknown) => {
    const ev = data as any;
    const evType = ev?.type;
    if (!evType) return;

    switch (evType) {
      case "account_info": {
        streamingAccountRef.current = { accountId: ev.accountId, accountLabel: ev.accountLabel };
        setStatusMessage(null);
        break;
      }

      case "account_retry": {
        // Update streaming account to the new one being tried
        if (ev.accountId && ev.accountLabel) {
          streamingAccountRef.current = { accountId: ev.accountId, accountLabel: ev.accountLabel };
        }
        // Surface retry as a system-level event in the stream
        streamingEventsRef.current.push(ev as ChatEvent);
        syncMessages();
        break;
      }

      case "status_update": {
        const label = ev.accountLabel ? ` (${ev.accountLabel})` : "";
        setStatusMessage(`${ev.message}${label}`);
        break;
      }

      case "text": {
        const pid = ev.parentToolUseId as string | undefined;
        if (pid && routeToParent(ev as ChatEvent, pid)) {
          syncMessages();
          break;
        }
        streamingContentRef.current += ev.content;
        streamingEventsRef.current.push(ev as ChatEvent);
        syncMessages();
        break;
      }

      case "thinking": {
        const pid = ev.parentToolUseId as string | undefined;
        if (pid && routeToParent(ev as ChatEvent, pid)) {
          syncMessages();
          break;
        }
        streamingEventsRef.current.push(ev as ChatEvent);
        syncMessages();
        break;
      }

      case "tool_use": {
        const pid = ev.parentToolUseId as string | undefined;
        if (pid && routeToParent(ev as ChatEvent, pid)) {
          syncMessages();
          break;
        }
        streamingEventsRef.current.push(ev as ChatEvent);
        syncMessages();
        break;
      }

      case "tool_result": {
        const pid = ev.parentToolUseId as string | undefined;
        if (pid && routeToParent(ev as ChatEvent, pid)) {
          syncMessages();
          break;
        }
        streamingEventsRef.current.push(ev as ChatEvent);
        syncMessages();
        break;
      }

      case "approval_request": {
        streamingEventsRef.current.push(ev as ChatEvent);
        setPendingApproval({
          requestId: ev.requestId,
          tool: ev.tool,
          input: ev.input,
        });
        if (sessionIdRef.current && !isSessionTabActive(sessionIdRef.current)) {
          const nType = ev.tool === "AskUserQuestion" ? "question" : "approval_request";
          useNotificationStore.getState().addNotification(sessionIdRef.current, nType, projectNameRef.current);
          playNotificationSound(nType);
        }
        break;
      }

      case "error": {
        streamingEventsRef.current.push(ev as ChatEvent);
        const errEvents = [...streamingEventsRef.current];
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [...prev.slice(0, -1), { ...last, events: errEvents }];
          }
          return [...prev, {
            id: `error-${Date.now()}`,
            role: "system" as const,
            content: ev.message,
            events: [ev as ChatEvent],
            timestamp: new Date().toISOString(),
          }];
        });
        // Phase reset comes from BE via phase_changed
        break;
      }

      case "team_detected": {
        const teamName = ev.teamName as string;
        if (teamName) {
          teamActivityRef.current.teamNames.add(teamName);
          // Fetch full team data from REST
          api.get<any>(`/api/teams/${encodeURIComponent(teamName)}`).then((res: any) => {
            if (res?.messages) {
              const existing = teamActivityRef.current.messages;
              const newMsgs = (res.messages as any[]).filter(
                (m: any) => !existing.some((e) => e.timestamp === m.timestamp && e.from === m.from)
              );
              existing.push(...newMsgs);
              existing.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
            }
            updateTeamActivity();
          }).catch(() => {});
          updateTeamActivity();
        }
        break;
      }

      case "team_inbox": {
        const msgs = (ev as any).messages as any[];
        if (Array.isArray(msgs)) {
          teamActivityRef.current.messages.push(...msgs);
          teamUnreadRef.current += msgs.length;
          updateTeamActivity();
        }
        break;
      }

      case "team_updated": {
        updateTeamActivity();
        break;
      }

      case "done": {
        // Idempotent: may receive duplicate done (provider + stream loop finally)
        if (phaseRef.current === "idle") break;
        if (ev.contextWindowPct != null) {
          setContextWindowPct(ev.contextWindowPct);
        }
        if (sessionIdRef.current && !isSessionTabActive(sessionIdRef.current)) {
          useNotificationStore.getState().addNotification(sessionIdRef.current, "done", projectNameRef.current);
          playNotificationSound("done");
        }
        // Finalize the streaming message
        const finalContent = streamingContentRef.current;
        const finalEvents = [...streamingEventsRef.current];
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [...prev.slice(0, -1), {
              ...last,
              id: `final-${Date.now()}`,
              content: finalContent || last.content,
              events: finalEvents.length > 0 ? finalEvents : last.events,
            }];
          }
          return prev;
        });
        streamingContentRef.current = "";
        streamingEventsRef.current = [];
        streamingAccountRef.current = null;
        setStatusMessage(null);
        // Phase transition to idle comes from BE via phase_changed
        break;
      }
    }
  }, [routeToParent, syncMessages]);

  const handleMessage = useCallback((event: MessageEvent) => {
    let data: ChatWsServerMessage;
    try {
      data = JSON.parse(event.data as string) as ChatWsServerMessage;
    } catch {
      return;
    }

    // Ignore keepalive pings
    if ((data as any).type === "ping") return;

    // Handle session ID migration (CLI provider assigned different ID)
    if ((data as any).type === "session_migrated") {
      const newId = (data as any).newSessionId as string;
      if (newId) setMigratedSessionId(newId);
      return;
    }

    // Handle title updates from SDK summary
    if ((data as any).type === "title_updated") {
      setSessionTitle((data as any).title ?? null);
      return;
    }

    // Handle compact status events
    if ((data as any).type === "compact_status") {
      const status = (data as any).status;
      if (status === "compacting") {
        setCompactStatus("compacting");
      } else if (status === "done") {
        setCompactStatus(null);
        // Refresh messages to show compacted history
        refetchRef.current?.();
      }
      return;
    }

    // Handle phase transitions from BE
    if ((data as any).type === "phase_changed") {
      const p = (data as any).phase as SessionPhase;
      setPhase(p);
      phaseRef.current = p;
      setConnectingElapsed(p === "connecting" ? ((data as any).elapsed ?? 0) : 0);
      return;
    }

    // Handle session state (replaces connected + status)
    if ((data as any).type === "session_state") {
      setIsConnected(true);
      const state = data as any;
      const p = state.phase as SessionPhase;
      setPhase(p);
      phaseRef.current = p;
      if (state.sessionTitle) setSessionTitle(state.sessionTitle);
      if (state.pendingApproval) {
        setPendingApproval({
          requestId: state.pendingApproval.requestId,
          tool: state.pendingApproval.tool,
          input: state.pendingApproval.input,
        });
      }
      // If idle, refetch history (completed turns) and hide overlay
      if (p === "idle") {
        refetchRef.current?.();
        setIsReconnecting(false);
      }
      // If streaming, turn_events message will follow
      return;
    }

    // Handle turn_events (reconnect sync with rAF chunking)
    if ((data as any).type === "turn_events") {
      const events = (data as any).events as unknown[];
      if (!events?.length) { setIsReconnecting(false); return; }

      // Truncate messages after last user message
      setMessages(prev => {
        const lastUserIdx = prev.findLastIndex(m => m.role === "user");
        return lastUserIdx >= 0 ? prev.slice(0, lastUserIdx + 1) : prev;
      });

      // Reset streaming refs
      streamingContentRef.current = "";
      streamingEventsRef.current = [];
      streamingAccountRef.current = null;

      // Process events in chunks via requestAnimationFrame to avoid blocking main thread
      const CHUNK_SIZE = 100;
      let offset = 0;
      const processChunk = () => {
        const end = Math.min(offset + CHUNK_SIZE, events.length);
        for (let i = offset; i < end; i++) {
          processStreamEvent(events[i]);
        }
        offset = end;
        if (offset < events.length) {
          requestAnimationFrame(processChunk);
        } else {
          setIsReconnecting(false);
        }
      };
      requestAnimationFrame(processChunk);
      return;
    }

    // Route content events through processStreamEvent
    processStreamEvent(data);
  }, [processStreamEvent]);

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

    setPhase("idle");
    phaseRef.current = "idle";
    setPendingApproval(null);
    setCompactStatus(null);
    streamingContentRef.current = "";
    streamingEventsRef.current = [];
    setIsConnected(false);
    // Reset team state
    teamActivityRef.current = { teamNames: new Set(), messages: [] };
    teamUnreadRef.current = 0;
    setTeamActivity(EMPTY_TEAM_ACTIVITY);
    setTeamMessages([]);

    if (sessionId && projectName) {
      setMessagesLoading(true);
      fetch(`${projectUrl(projectName)}/chat/sessions/${sessionId}/messages?providerId=${providerId}`, {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      })
        .then((r) => r.json())
        .then((json: any) => {
          if (cancelled || phaseRef.current !== "idle") return;
          if (json.ok && Array.isArray(json.data) && json.data.length > 0) {
            setMessages(json.data);
          } else {
            setMessages([]);
          }
        })
        .catch(() => {
          if (!cancelled && phaseRef.current === "idle") setMessages([]);
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
    (content: string, opts?: { permissionMode?: string; priority?: 'now' | 'next' | 'later'; images?: Array<{ data: string; mediaType: string }> }) => {
      if (!content.trim()) return;

      const isFollowUp = phaseRef.current !== "idle";

      if (isFollowUp) {
        // Streaming follow-up: finalize current assistant message, then send
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

      // Reset streaming state for new turn
      streamingContentRef.current = "";
      streamingEventsRef.current = [];
      pendingMessageRef.current = null;
      if (!isFollowUp) {
        setPhase("initializing");
        phaseRef.current = "initializing";
      } else {
        setPhase("thinking");
        phaseRef.current = "thinking";
      }
      setPendingApproval(null);

      send(JSON.stringify({
        type: "message",
        content,
        permissionMode: opts?.permissionMode,
        priority: opts?.priority,
        images: opts?.images,
      }));
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
          const inp = (askEvt as any).input;
          if (inp && typeof inp === "object") {
            (inp as Record<string, unknown>).answers = data;
          }
        }
        setMessages((prev) => [...prev]);
      }

      setPendingApproval(null);
    },
    [send],
  );

  const cancelStreaming = useCallback(() => {
    if (phaseRef.current === "idle") return;
    send(JSON.stringify({ type: "cancel" }));
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
    setPhase("idle");
    phaseRef.current = "idle";
    setPendingApproval(null);
  }, [send]);

  const reconnect = useCallback(() => {
    setIsConnected(false);
    setIsReconnecting(true);
    wsReconnect();
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
          streamingContentRef.current = "";
          streamingEventsRef.current = [];
        }
      })
      .catch(() => {})
      .finally(() => setMessagesLoading(false));
  }, [sessionId, providerId, projectName]);

  // Keep refetchRef in sync
  refetchRef.current = refetchMessages;

  return {
    messages,
    messagesLoading,
    isStreaming,
    phase,
    isReconnecting,
    connectingElapsed,
    pendingApproval,
    contextWindowPct,
    compactStatus,
    statusMessage,
    sessionTitle,
    migratedSessionId,
    teamActivity,
    teamMessages,
    markTeamRead,
    sendMessage,
    respondToApproval,
    cancelStreaming,
    reconnect,
    refetchMessages,
    isConnected,
  };
}
