import { useState, useCallback } from "react";
import { api } from "@/lib/api-client";
import { useChat } from "@/hooks/use-chat";
import { useTabStore } from "@/stores/tab-store";
import { useProjectStore } from "@/stores/project-store";
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
    (metadata?.providerId as string) ?? "claude-sdk",
  );

  const activeProject = useProjectStore((s) => s.activeProject);

  const {
    messages,
    isStreaming,
    pendingApproval,
    sendMessage,
    respondToApproval,
    isConnected,
  } = useChat(sessionId, providerId);

  const handleNewSession = useCallback(() => {
    // Open a new chat tab (separate tab, not replace current)
    useTabStore.getState().openTab({
      type: "chat",
      title: "AI Chat",
      metadata: { projectName: metadata?.project },
      closable: true,
    });
  }, [metadata?.project]);

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
      {/* Messages */}
      <MessageList
        messages={messages}
        pendingApproval={pendingApproval}
        onApprovalResponse={respondToApproval}
        isStreaming={isStreaming}
      />

      {/* Bottom toolbar: session picker (left) + connection status + input */}
      <div className="border-t border-border bg-background shrink-0">
        {/* Session bar */}
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/50">
          <SessionPicker
            currentSessionId={sessionId}
            onSelectSession={handleSelectSession}
            onNewSession={handleNewSession}
            projectDir={activeProject?.path}
          />
          <div className="flex items-center gap-2">
            {isConnected && (
              <span className="size-2 rounded-full bg-green-500" title="Connected" />
            )}
            <span className="text-xs text-text-subtle">AI Chat</span>
          </div>
        </div>
        {/* Input */}
        <MessageInput onSend={handleSend} disabled={isStreaming} />
      </div>
    </div>
  );
}
