import { useState, useCallback, useRef, useEffect } from "react";
import { useWebSocket } from "./use-websocket";
import { api, getAuthToken, projectUrl } from "@/lib/api-client";
import { useNotificationStore } from "@/stores/notification-store";
import { useStreamingStore } from "@/stores/streaming-store";
import { usePanelStore } from "@/stores/panel-store";
import { playNotificationSound } from "@/lib/notification-sounds";
import { toast } from "sonner";
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

export interface BashPartialEntry {
  content: string;
  lineCount: number;
}

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
  /** Team activity state from WS events */
  teamActivity: TeamActivityState;
  /** All team messages (ref-backed, updated live) */
  teamMessages: TeamMessageItem[];
  /** Mark team messages as read (reset unread counter) */
  markTeamRead: () => void;
  /** Partial bash output keyed by toolUseId (ref-backed for perf) */
  bashPartialOutput: React.RefObject<Map<string, BashPartialEntry>>;
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
  const streamingContentRef = useRef("");
  const streamingEventsRef = useRef<ChatEvent[]>([]);
  const bashOutputRef = useRef<Map<string, BashPartialEntry>>(new Map());
  const streamingAccountRef = useRef<{ accountId: string; accountLabel: string } | null>(null);
  const phaseRef = useRef<SessionPhase>("idle");
  const pendingMessageRef = useRef<string | null>(null);
  const sendRef = useRef<(data: string) => void>(() => {});
  const refetchRef = useRef<(() => void) | null>(null);
  /** True while replaying turn_events — suppresses setPendingApproval */
  const isReplayingRef = useRef(false);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const projectNameRef = useRef(projectName);
  projectNameRef.current = projectName;
  /** Toast ID for the current pending approval notification */
  const approvalToastRef = useRef<string | number | null>(null);
  /** RAF handle for throttled syncMessages */
  const syncRafRef = useRef<number>(0);

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

  // Sync streaming state to global store (for favicon + tab icon indicators)
  useEffect(() => {
    if (!sessionId) return;
    useStreamingStore.getState().setStreaming(sessionId, phase !== "idle");
    return () => { useStreamingStore.getState().setStreaming(sessionId, false); };
  }, [sessionId, phase]);

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

  /** Flush refs into React state (called from rAF or directly) */
  const flushMessages = useCallback(() => {
    syncRafRef.current = 0;
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

  /** Throttled sync — batches rapid WS events into one render per animation frame */
  const syncMessages = useCallback(() => {
    if (!syncRafRef.current) {
      syncRafRef.current = requestAnimationFrame(flushMessages);
    }
  }, [flushMessages]);

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
        // Clear previous streaming events (error text from failed attempt)
        // and start fresh with only the retry notification
        streamingEventsRef.current = [ev as ChatEvent];
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
        // Clear bash partial output for this tool
        const trId = ev.toolUseId as string;
        if (trId) bashOutputRef.current.delete(trId);

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
        // During turn_events replay, session_state already set the correct
        // pendingApproval — skip re-setting it for historical (already-answered) events
        if (isReplayingRef.current) break;
        setPendingApproval({
          requestId: ev.requestId,
          tool: ev.tool,
          input: ev.input,
        });
        if (sessionIdRef.current && !isSessionTabActive(sessionIdRef.current)) {
          const nType = ev.tool === "AskUserQuestion" ? "question" : "approval_request";
          useNotificationStore.getState().addNotification(sessionIdRef.current, nType, projectNameRef.current);
          playNotificationSound(nType);
          // Persistent toast with action to navigate to the waiting session
          const sid = sessionIdRef.current;
          const isQuestion = ev.tool === "AskUserQuestion";
          approvalToastRef.current = toast[isQuestion ? "info" : "warning"](
            isQuestion ? "AI has a question" : `${ev.tool} needs permission`,
            {
              description: projectNameRef.current || `Session ${sid.slice(0, 8)}`,
              duration: Infinity,
              action: {
                label: "Go to session",
                onClick: () => {
                  const { panels } = usePanelStore.getState();
                  for (const [panelId, panel] of Object.entries(panels)) {
                    const tab = panel.tabs.find((t) => t.metadata?.sessionId === sid);
                    if (tab) {
                      usePanelStore.getState().setActiveTab(tab.id, panelId);
                      break;
                    }
                  }
                },
              },
            },
          );
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
              if (existing.length > 500) existing.splice(0, existing.length - 500);
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
          const existing = teamActivityRef.current.messages;
          existing.push(...msgs);
          if (existing.length > 500) existing.splice(0, existing.length - 500);
          teamUnreadRef.current += msgs.length;
          updateTeamActivity();
        }
        break;
      }

      case "team_updated": {
        updateTeamActivity();
        break;
      }

      case "bash_output": {
        const tuId = ev.toolUseId as string;
        if (tuId) {
          const existing = bashOutputRef.current.get(tuId);
          if (existing) {
            existing.content += ev.content;
            // Cap at ~500KB to prevent browser OOM on long-running commands
            if (existing.content.length > 500_000) {
              existing.content = existing.content.slice(-500_000);
            }
            existing.lineCount = ev.lineCount as number;
          } else {
            bashOutputRef.current.set(tuId, {
              content: ev.content as string,
              lineCount: ev.lineCount as number,
            });
          }
          syncMessages();
        }
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
        // Cancel any pending throttled sync — done handler writes final state directly
        if (syncRafRef.current) { cancelAnimationFrame(syncRafRef.current); syncRafRef.current = 0; }
        // Finalize the streaming message — preserve SDK UUID for fork/rewind
        const finalContent = streamingContentRef.current;
        const finalEvents = [...streamingEventsRef.current];
        const finalAccount = streamingAccountRef.current;
        const doneUuid = ev.lastMessageUuid as string | undefined;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [...prev.slice(0, -1), {
              ...last,
              id: `final-${Date.now()}`,
              content: finalContent || last.content,
              events: finalEvents.length > 0 ? finalEvents : last.events,
              ...(doneUuid && { sdkUuid: doneUuid }),
            }];
          }
          // No assistant message flushed yet (rAF was still pending when cancelled).
          // Create one from accumulated refs so the response isn't silently lost.
          if (finalContent || finalEvents.length > 0) {
            return [...prev, {
              id: `final-${Date.now()}`,
              role: "assistant" as const,
              content: finalContent,
              events: finalEvents,
              timestamp: new Date().toISOString(),
              ...(doneUuid && { sdkUuid: doneUuid }),
              ...finalAccount,
            }];
          }
          return prev;
        });
        streamingContentRef.current = "";
        streamingEventsRef.current = [];
        streamingAccountRef.current = null;
        bashOutputRef.current.clear();
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

    // Dispatch file change events for real-time editor reload
    if ((data as any).type === "file:changed") {
      window.dispatchEvent(new CustomEvent("file:changed", { detail: data }));
      return;
    }

    // Dispatch global Jira events so components can listen via window events
    if (typeof (data as any).type === "string" && (data as any).type.startsWith("jira:")) {
      window.dispatchEvent(new CustomEvent((data as any).type, { detail: data }));
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
      const userMessage = (data as any).userMessage as string | null;
      if (!events?.length && !userMessage) { setIsReconnecting(false); return; }

      // Remove stale streaming assistant message + inject current turn's user message
      setMessages(prev => {
        let updated = prev;
        // Only remove in-progress streaming assistant (not finalized or REST-loaded)
        const last = updated[updated.length - 1];
        if (last?.role === "assistant" && last.id.startsWith("streaming-")) {
          updated = updated.slice(0, -1);
        }
        // Add the current turn's user message if not already present
        if (userMessage) {
          const lastAfter = updated[updated.length - 1];
          if (lastAfter?.role !== "user" || lastAfter.content !== userMessage) {
            updated = [...updated, {
              id: `user-replay-${Date.now()}`,
              role: "user" as const,
              content: userMessage,
              timestamp: new Date().toISOString(),
            }];
          }
        }
        return updated;
      });

      // Reset streaming refs
      streamingContentRef.current = "";
      streamingEventsRef.current = [];
      streamingAccountRef.current = null;

      // Process events in chunks via requestAnimationFrame to avoid blocking main thread
      isReplayingRef.current = true;
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
          isReplayingRef.current = false;
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
    if (approvalToastRef.current != null) { toast.dismiss(approvalToastRef.current); approvalToastRef.current = null; }
    setCompactStatus(null);
    streamingContentRef.current = "";
    streamingEventsRef.current = [];
    bashOutputRef.current.clear();
    if (syncRafRef.current) { cancelAnimationFrame(syncRafRef.current); syncRafRef.current = 0; }
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
        // Cancel pending throttled sync before finalizing
        if (syncRafRef.current) { cancelAnimationFrame(syncRafRef.current); syncRafRef.current = 0; }
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
      if (approvalToastRef.current != null) { toast.dismiss(approvalToastRef.current); approvalToastRef.current = null; }

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
      if (approvalToastRef.current != null) { toast.dismiss(approvalToastRef.current); approvalToastRef.current = null; }
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
    bashOutputRef.current.clear();
    pendingMessageRef.current = null;
    setPhase("idle");
    phaseRef.current = "idle";
    setPendingApproval(null);
    if (approvalToastRef.current != null) { toast.dismiss(approvalToastRef.current); approvalToastRef.current = null; }
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
    teamActivity,
    teamMessages,
    markTeamRead,
    bashPartialOutput: bashOutputRef,
    sendMessage,
    respondToApproval,
    cancelStreaming,
    reconnect,
    refetchMessages,
    isConnected,
  };
}
