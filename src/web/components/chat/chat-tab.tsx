import { useEffect, useState } from "react";
import { api } from "../../lib/api-client";
import type { SessionInfo } from "../../../types/chat";
import { useChat } from "../../hooks/use-chat";
import { MessageList } from "./message-list";
import { MessageInput } from "./message-input";
import { ToolApproval } from "./tool-approval";
import { SessionPicker } from "./session-picker";
import { Loader2 } from "lucide-react";

interface ChatTabProps {
  sessionId?: string;
}

function ChatSession({ sessionId }: { sessionId: string }) {
  const { messages, isStreaming, pendingApproval, sendMessage, respondToApproval } =
    useChat(sessionId);

  return (
    <div className="flex flex-col h-full">
      <MessageList messages={messages} />
      {pendingApproval && (
        <ToolApproval
          tool={pendingApproval.tool}
          input={pendingApproval.input}
          onApprove={() => respondToApproval(pendingApproval.requestId, true)}
          onDeny={() => respondToApproval(pendingApproval.requestId, false)}
        />
      )}
      <MessageInput onSend={sendMessage} disabled={isStreaming} />
    </div>
  );
}

export function ChatTab({ sessionId: initialSessionId }: ChatTabProps) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(initialSessionId);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [creating, setCreating] = useState(false);

  const fetchSessions = () => {
    setLoadingSessions(true);
    api
      .get<SessionInfo[]>("/api/chat/sessions")
      .then(setSessions)
      .catch(console.error)
      .finally(() => setLoadingSessions(false));
  };

  useEffect(() => {
    fetchSessions();
  }, []);

  const handleNew = async () => {
    setCreating(true);
    try {
      const session = await api.post<{ id: string; title: string; createdAt: string }>(
        "/api/chat/sessions",
        {},
      );
      setSessions((prev) => [
        { id: session.id, title: session.title, createdAt: session.createdAt, messageCount: 0 },
        ...prev,
      ]);
      setActiveSessionId(session.id);
    } catch (err) {
      console.error("Failed to create session:", err);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border shrink-0">
        {loadingSessions ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        ) : (
          <SessionPicker
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelect={setActiveSessionId}
            onNew={handleNew}
          />
        )}
        {creating && <Loader2 className="size-3.5 animate-spin text-muted-foreground ml-1" />}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {activeSessionId ? (
          <ChatSession sessionId={activeSessionId} />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            {loadingSessions ? "Loading..." : "Start a new chat"}
          </div>
        )}
      </div>
    </div>
  );
}
