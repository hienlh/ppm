import { useState, useCallback } from "react";
import { Bot } from "lucide-react";
import { api } from "@/lib/api-client";
import { useChat } from "@/hooks/use-chat";
import { MessageList } from "./message-list";
import { MessageInput } from "./message-input";
import { SessionPicker } from "./session-picker";
import type { Session, SessionInfo } from "../../../types/chat";

interface ChatTabProps {
  metadata?: Record<string, unknown>;
}

export function ChatTab({ metadata }: ChatTabProps) {
  const [sessionId, setSessionId] = useState<string | null>(
    (metadata?.sessionId as string) ?? null,
  );
  const [providerId, setProviderId] = useState<string>(
    (metadata?.providerId as string) ?? "claude",
  );

  const {
    messages,
    isStreaming,
    pendingApproval,
    sendMessage,
    respondToApproval,
    isConnected,
  } = useChat(sessionId);

  const handleNewSession = useCallback(async () => {
    try {
      const session = await api.post<Session>("/api/chat/sessions", {
        providerId,
        projectName: metadata?.project as string,
      });
      setSessionId(session.id);
      setProviderId(session.providerId);
    } catch (e) {
      console.error("Failed to create session:", e);
    }
  }, [providerId, metadata?.project]);

  const handleSelectSession = useCallback((session: SessionInfo) => {
    setSessionId(session.id);
    setProviderId(session.providerId);
  }, []);

  const handleSend = useCallback(
    async (content: string) => {
      // Auto-create session on first message
      if (!sessionId) {
        try {
          const session = await api.post<Session>("/api/chat/sessions", {
            providerId,
            projectName: metadata?.project as string,
            title: content.slice(0, 50),
          });
          setSessionId(session.id);
          setProviderId(session.providerId);
          // Message will be sent after WS connects via effect
          // For simplicity, we delay and send through the new session
          setTimeout(() => {
            sendMessage(content);
          }, 500);
          return;
        } catch (e) {
          console.error("Failed to create session:", e);
          return;
        }
      }
      sendMessage(content);
    },
    [sessionId, providerId, metadata?.project, sendMessage],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-background shrink-0">
        <div className="flex items-center gap-2">
          <Bot className="size-4 text-primary" />
          <span className="text-sm font-medium text-text-primary">AI Chat</span>
          {isConnected && (
            <span className="size-2 rounded-full bg-green-500" title="Connected" />
          )}
        </div>
        <SessionPicker
          currentSessionId={sessionId}
          onSelectSession={handleSelectSession}
          onNewSession={handleNewSession}
        />
      </div>

      {/* Messages */}
      <MessageList
        messages={messages}
        pendingApproval={pendingApproval}
        onApprovalResponse={respondToApproval}
        isStreaming={isStreaming}
      />

      {/* Input */}
      <MessageInput onSend={handleSend} disabled={isStreaming} />
    </div>
  );
}
