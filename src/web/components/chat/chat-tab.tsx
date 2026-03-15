import { useState, useCallback, useRef, type DragEvent } from "react";
import { Upload } from "lucide-react";
import { api, projectUrl } from "@/lib/api-client";
import { useChat } from "@/hooks/use-chat";
import { useTabStore } from "@/stores/tab-store";
import { useProjectStore } from "@/stores/project-store";
import { MessageList } from "./message-list";
import { MessageInput, type ChatAttachment } from "./message-input";
import { SessionPicker } from "./session-picker";
import { SlashCommandPicker, type SlashItem } from "./slash-command-picker";
import { FilePicker } from "./file-picker";
import { UsageBadge, UsageDetailPanel } from "./usage-badge";
import type { FileNode } from "../../../types/project";
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

  // Slash picker state
  const [slashItems, setSlashItems] = useState<SlashItem[]>([]);
  const [showSlashPicker, setShowSlashPicker] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashSelected, setSlashSelected] = useState<SlashItem | null>(null);

  // File picker state
  const [fileItems, setFileItems] = useState<FileNode[]>([]);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [fileFilter, setFileFilter] = useState("");
  const [fileSelected, setFileSelected] = useState<FileNode | null>(null);

  // Usage detail panel
  const [showUsageDetail, setShowUsageDetail] = useState(false);

  // Drag-and-drop state
  const [isDragging, setIsDragging] = useState(false);
  const [externalFiles, setExternalFiles] = useState<File[] | null>(null);
  const dragCounterRef = useRef(0);

  const activeProject = useProjectStore((s) => s.activeProject);

  const {
    messages,
    isStreaming,
    pendingApproval,
    usageInfo,
    usageLoading,
    sendMessage,
    respondToApproval,
    cancelStreaming,
    refreshUsage,
    isConnected,
  } = useChat(sessionId, providerId, activeProject?.name ?? "");

  const handleNewSession = useCallback(() => {
    const projectName = activeProject?.name ?? null;
    useTabStore.getState().openTab({
      type: "chat",
      title: "AI Chat",
      metadata: { projectName },
      projectId: projectName,
      closable: true,
    });
  }, [activeProject?.name]);

  const handleSelectSession = useCallback((session: SessionInfo) => {
    setSessionId(session.id);
    setProviderId(session.providerId);
  }, []);

  /** Build message content with file references prepended */
  const buildMessageWithAttachments = useCallback(
    (content: string, attachments: ChatAttachment[]): string => {
      if (attachments.length === 0) return content;

      const fileRefs = attachments
        .filter((a) => a.serverPath)
        .map((a) => a.serverPath!)
        .join("\n");

      if (!fileRefs) return content;

      // Prepend file paths so Claude Code can read them
      const prefix = attachments.length === 1
        ? `[Attached file: ${fileRefs}]\n\n`
        : `[Attached files:\n${fileRefs}\n]\n\n`;

      return prefix + content;
    },
    [],
  );

  const handleSend = useCallback(
    async (content: string, attachments: ChatAttachment[] = []) => {
      const fullContent = buildMessageWithAttachments(content, attachments);
      if (!fullContent.trim()) return;

      if (!sessionId) {
        try {
          const pName = activeProject?.name ?? (metadata?.project as string) ?? "";
          const session = await api.post<Session>(`${projectUrl(pName)}/chat/sessions`, {
            providerId,
            title: content.slice(0, 50),
          });
          setSessionId(session.id);
          setProviderId(session.providerId);
          setTimeout(() => {
            sendMessage(fullContent);
          }, 500);
          return;
        } catch (e) {
          console.error("Failed to create session:", e);
          return;
        }
      }
      sendMessage(fullContent);
    },
    [sessionId, providerId, metadata?.project, sendMessage, buildMessageWithAttachments, activeProject?.name],
  );

  // --- Slash picker handlers ---
  const handleSlashStateChange = useCallback((visible: boolean, filter: string) => {
    setShowSlashPicker(visible);
    setSlashFilter(filter);
  }, []);

  const handleSlashSelect = useCallback((item: SlashItem) => {
    setSlashSelected(item);
    setShowSlashPicker(false);
    setSlashFilter("");
    setTimeout(() => setSlashSelected(null), 50);
  }, []);

  const handleSlashClose = useCallback(() => {
    setShowSlashPicker(false);
    setSlashFilter("");
  }, []);

  // --- File picker handlers ---
  const handleFileStateChange = useCallback((visible: boolean, filter: string) => {
    setShowFilePicker(visible);
    setFileFilter(filter);
  }, []);

  const handleFileSelect = useCallback((item: FileNode) => {
    setFileSelected(item);
    setShowFilePicker(false);
    setFileFilter("");
    setTimeout(() => setFileSelected(null), 50);
  }, []);

  const handleFileClose = useCallback(() => {
    setShowFilePicker(false);
    setFileFilter("");
  }, []);

  // --- Drag-and-drop on entire chat area ---
  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes("Files")) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      setExternalFiles(files);
      // Reset after a tick so the effect fires even with same files
      setTimeout(() => setExternalFiles(null), 100);
    }
  }, []);

  return (
    <div
      className="flex flex-col h-full relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm border-2 border-dashed border-primary rounded-lg pointer-events-none">
          <div className="flex flex-col items-center gap-2 text-primary">
            <Upload className="size-8" />
            <span className="text-sm font-medium">Drop files to attach</span>
          </div>
        </div>
      )}

      {/* Messages */}
      <MessageList
        messages={messages}
        pendingApproval={pendingApproval}
        onApprovalResponse={respondToApproval}
        isStreaming={isStreaming}
        projectName={activeProject?.name}
      />

      {/* Bottom toolbar */}
      <div className="border-t border-border bg-background shrink-0">
        {/* Session bar */}
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/50">
          <SessionPicker
            currentSessionId={sessionId}
            onSelectSession={handleSelectSession}
            onNewSession={handleNewSession}
            projectName={activeProject?.name}
          />
          <div className="flex items-center gap-2">
            <UsageBadge
              usage={usageInfo}
              onClick={() => setShowUsageDetail((v) => !v)}
            />
            {isConnected && (
              <span className="size-2 rounded-full bg-green-500" title="Connected" />
            )}
          </div>
        </div>

        {/* Usage detail panel (in-flow) */}
        <UsageDetailPanel
          usage={usageInfo}
          visible={showUsageDetail}
          onClose={() => setShowUsageDetail(false)}
          onReload={refreshUsage}
          loading={usageLoading}
        />

        {/* Pickers (in-flow, above input — only one visible at a time) */}
        <SlashCommandPicker
          items={slashItems}
          filter={slashFilter}
          onSelect={handleSlashSelect}
          onClose={handleSlashClose}
          visible={showSlashPicker}
        />
        <FilePicker
          items={fileItems}
          filter={fileFilter}
          onSelect={handleFileSelect}
          onClose={handleFileClose}
          visible={showFilePicker}
        />

        {/* Input */}
        <MessageInput
          onSend={handleSend}
          isStreaming={isStreaming}
          onCancel={cancelStreaming}
          projectName={activeProject?.name}
          onSlashStateChange={handleSlashStateChange}
          onSlashItemsLoaded={setSlashItems}
          slashSelected={slashSelected}
          onFileStateChange={handleFileStateChange}
          onFileItemsLoaded={setFileItems}
          fileSelected={fileSelected}
          externalFiles={externalFiles}
        />
      </div>
    </div>
  );
}
