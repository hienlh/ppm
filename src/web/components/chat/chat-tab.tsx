import { useState, useCallback, useRef, useEffect, type DragEvent } from "react";
import { Upload, Bug, Copy, ExternalLink, X } from "lucide-react";
import { api, projectUrl } from "@/lib/api-client";
import { useChat } from "@/hooks/use-chat";
import { useUsage } from "@/hooks/use-usage";
import { useTabStore } from "@/stores/tab-store";
import { useProjectStore } from "@/stores/project-store";
import { useSettingsStore } from "@/stores/settings-store";
import { buildBugReport, openGithubIssue, copyToClipboard } from "@/lib/report-bug";
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
  tabId?: string;
}

export function ChatTab({ metadata, tabId }: ChatTabProps) {
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

  // Bug report popup
  const [bugReportText, setBugReportText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Drag-and-drop state
  const [isDragging, setIsDragging] = useState(false);
  const [externalFiles, setExternalFiles] = useState<File[] | null>(null);
  const dragCounterRef = useRef(0);

  const activeProject = useProjectStore((s) => s.activeProject);
  const updateTab = useTabStore((s) => s.updateTab);
  const version = useSettingsStore((s) => s.version);

  // Usage runs independently — auto-refreshes on interval
  const { usageInfo, usageLoading, lastUpdatedAt, refreshUsage, mergeUsage } =
    useUsage(activeProject?.name ?? "", providerId);

  // Persist sessionId and providerId to tab metadata so reload restores the session
  useEffect(() => {
    if (!tabId || !sessionId) return;
    updateTab(tabId, {
      metadata: { ...metadata, sessionId, providerId },
    });
  }, [sessionId, providerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const {
    messages,
    messagesLoading,
    isStreaming,
    pendingApproval,
    sendMessage,
    respondToApproval,
    cancelStreaming,
    reconnect,
    refetchMessages,
    isConnected,
  } = useChat(sessionId, providerId, activeProject?.name ?? "", { onUsageEvent: mergeUsage });

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
        messagesLoading={messagesLoading}
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
              loading={usageLoading}
              onClick={() => setShowUsageDetail((v) => !v)}
            />
            {sessionId && (
              <button
                onClick={async () => {
                  const text = await buildBugReport(version, { sessionId, projectName: activeProject?.name });
                  setBugReportText(text);
                  setCopied(false);
                }}
                className="p-0.5 rounded hover:bg-surface-elevated text-text-subtle hover:text-text-secondary transition-colors"
                title="Report bug for this chat session"
              >
                <Bug className="size-3.5" />
              </button>
            )}
            <button
              onClick={() => {
                if (!isConnected) reconnect();
                refetchMessages();
              }}
              className="group relative size-4 flex items-center justify-center rounded-full hover:bg-surface-hover transition-colors"
              title={isConnected ? "Connected — click to refetch messages" : "Disconnected — click to reconnect"}
            >
              <span
                className={`size-2 rounded-full transition-colors ${
                  isConnected ? "bg-green-500" : "bg-red-500 animate-pulse"
                }`}
              />
            </button>
          </div>
        </div>

        {/* Usage detail panel (in-flow) */}
        <UsageDetailPanel
          usage={usageInfo}
          visible={showUsageDetail}
          onClose={() => setShowUsageDetail(false)}
          onReload={refreshUsage}
          loading={usageLoading}
          lastUpdatedAt={lastUpdatedAt}
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

      {/* Bug report popup */}
      {bugReportText && (
        <>
          <div className="fixed inset-0 z-50 bg-black/50" onClick={() => setBugReportText(null)} />
          <div className="fixed inset-x-4 top-[10%] bottom-[10%] z-50 mx-auto max-w-lg flex flex-col rounded-lg border border-border bg-background shadow-xl">
            <div className="flex items-center justify-between px-4 py-2 border-b border-border">
              <span className="text-sm font-medium">Bug Report</span>
              <button onClick={() => setBugReportText(null)} className="p-1 rounded hover:bg-surface-elevated">
                <X className="size-4" />
              </button>
            </div>
            <pre className="flex-1 overflow-auto px-4 py-2 text-xs font-mono whitespace-pre-wrap break-all">{bugReportText}</pre>
            <div className="flex gap-2 px-4 py-3 border-t border-border">
              <button
                onClick={async () => {
                  const ok = await copyToClipboard(bugReportText);
                  if (ok) setCopied(true);
                }}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg bg-surface hover:bg-surface-elevated border border-border transition-colors"
              >
                <Copy className="size-4" />
                {copied ? "Copied!" : "Copy"}
              </button>
              <button
                onClick={() => {
                  openGithubIssue(bugReportText);
                  setBugReportText(null);
                }}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg bg-primary text-white hover:bg-primary/90 transition-colors"
              >
                <ExternalLink className="size-4" />
                GitHub Issue
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
