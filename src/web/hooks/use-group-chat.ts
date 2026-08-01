import { useState, useCallback, useRef, useEffect } from "react";
import { useWebSocket } from "./use-websocket";
import { getFeed, sendGroupMessage, stopGroup, resumeGroup } from "@/lib/api-group-chat";
import type { GroupMessage, GroupStatus, MemberStatus } from "../../types/group-chat";
import type { GroupChatServerMessage } from "../../types/group-chat-ws";

/** A roster member as surfaced to the UI (from group_state + live member_status). */
export interface RosterMember {
  id: string;
  name: string;
  role: string;
  status: MemberStatus;
  color: string | null;
}

interface UseGroupChatReturn {
  messages: GroupMessage[];
  members: RosterMember[];
  status: GroupStatus;
  /** Member name → true while that member is composing a turn. */
  typing: Record<string, boolean>;
  loading: boolean;
  isConnected: boolean;
  /** True while the engine is actively running turns. */
  isRunning: boolean;
  error: string | null;
  sendMessage: (content: string) => void;
  stop: () => void;
  resume: () => void;
}

const TYPING_TIMEOUT_MS = 8000;

export function useGroupChat(groupId: string | null, projectName: string): UseGroupChatReturn {
  const [messages, setMessages] = useState<GroupMessage[]>([]);
  const [members, setMembers] = useState<RosterMember[]>([]);
  const [status, setStatus] = useState<GroupStatus>("idle");
  const [typing, setTyping] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearTyping = useCallback((member: string) => {
    setTyping((prev) => {
      if (!prev[member]) return prev;
      const next = { ...prev };
      delete next[member];
      return next;
    });
  }, []);

  const handleMessage = useCallback((event: MessageEvent) => {
    let data: GroupChatServerMessage;
    try {
      data = JSON.parse(event.data as string) as GroupChatServerMessage;
    } catch {
      return;
    }

    switch (data.type) {
      case "ping":
        return;

      case "group_state": {
        setIsConnected(true);
        setStatus(data.status);
        setMembers(data.members);
        setIsRunning(data.status === "active");
        return;
      }

      case "group_message": {
        // Arrival of a member's turn ends their typing indicator.
        clearTyping(data.message.fromMember);
        setMessages((prev) => {
          if (prev.some((m) => m.id === data.message.id)) return prev;
          return [...prev, data.message];
        });
        return;
      }

      case "member_status": {
        setMembers((prev) =>
          prev.map((m) => (m.id === data.memberId ? { ...m, status: data.status } : m)),
        );
        return;
      }

      case "typing": {
        setTyping((prev) => ({ ...prev, [data.member]: true }));
        const timers = typingTimers.current;
        const existing = timers.get(data.member);
        if (existing) clearTimeout(existing);
        timers.set(
          data.member,
          setTimeout(() => clearTyping(data.member), TYPING_TIMEOUT_MS),
        );
        return;
      }

      case "turn_done":
        return;

      case "group_done": {
        setIsRunning(false);
        setStatus("idle");
        setTyping({});
        return;
      }

      case "error": {
        setError(data.message);
        setIsRunning(false);
        return;
      }
    }
  }, [clearTyping]);

  const wsUrl = groupId && projectName
    ? `/ws/project/${encodeURIComponent(projectName)}/group/${encodeURIComponent(groupId)}`
    : "";

  const { send } = useWebSocket({
    url: wsUrl,
    onMessage: handleMessage,
    autoConnect: !!groupId && !!projectName,
  });

  // Load feed history + reset on group change.
  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setMembers([]);
    setTyping({});
    setStatus("idle");
    setIsRunning(false);
    setError(null);
    setIsConnected(false);
    for (const t of typingTimers.current.values()) clearTimeout(t);
    typingTimers.current.clear();

    if (!groupId) return;
    setLoading(true);
    getFeed(groupId, { limit: 200 })
      .then((res) => {
        if (cancelled) return;
        // Merge, don't clobber: a live WS message (e.g. the very first message on a
        // brand-new group) can arrive BEFORE this fetch resolves. Keep any such live
        // messages that the fetched snapshot doesn't already include.
        setMessages((prev) => {
          const fetchedIds = new Set(res.messages.map((m) => m.id));
          const liveExtra = prev.filter((m) => !fetchedIds.has(m.id));
          return [...res.messages, ...liveExtra];
        });
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load feed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [groupId]);

  const sendMessage = useCallback((content: string) => {
    const trimmed = content.trim();
    if (!trimmed || !groupId) return;
    setError(null);
    setIsRunning(true);
    // WS is the live channel; the REST POST kicks the engine when idle.
    if (isConnected) {
      send(JSON.stringify({ type: "message", content: trimmed }));
    } else {
      sendGroupMessage(groupId, trimmed).catch((e) => {
        setError(e instanceof Error ? e.message : "Failed to send message");
        setIsRunning(false);
      });
    }
  }, [groupId, isConnected, send]);

  const stop = useCallback(() => {
    if (!groupId) return;
    if (isConnected) send(JSON.stringify({ type: "stop" }));
    else stopGroup(groupId).catch(() => {});
    setStatus("paused");
    setIsRunning(false);
  }, [groupId, isConnected, send]);

  const resume = useCallback(() => {
    if (!groupId) return;
    resumeGroup(groupId)
      .then(() => { setStatus("active"); setIsRunning(true); })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to resume"));
  }, [groupId]);

  return {
    messages, members, status, typing, loading, isConnected, isRunning, error,
    sendMessage, stop, resume,
  };
}
