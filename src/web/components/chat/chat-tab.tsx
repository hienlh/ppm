import { useState, useCallback, useRef, useEffect } from "react";
import { Loader2, Upload, X } from "lucide-react";
import { api, projectUrl } from "@/lib/api-client";
import { useChat } from "@/hooks/use-chat";
import { useUsage } from "@/hooks/use-usage";
import { useTabStore } from "@/stores/tab-store";
import { useSettingsStore } from "@/stores/settings-store";
import { usePanelStore } from "@/stores/panel-store";
import { useNotificationStore } from "@/stores/notification-store";
import { openBugReportPopup } from "@/lib/report-bug";
import { getAISettings } from "@/lib/api-settings";
import { MessageList } from "./message-list";
import { MessageInput, type ChatAttachment, type MessagePriority } from "./message-input";
import { SlashCommandPicker, type SlashItem } from "./slash-command-picker";
import { FilePicker } from "./file-picker";
import { ChatHistoryBar } from "./chat-history-bar";

import type { DragEvent } from "react";
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
    (metadata?.providerId as string) ?? "claude",
  );

  // Slash picker state
  const [slashItems, setSlashItems] = useState<SlashItem[]>([]);
  const [showSlashPicker, setShowSlashPicker] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashRanked, setSlashRanked] = useState(false);
  const [slashSelected, setSlashSelected] = useState<SlashItem | null>(null);
  const [slashRecentNames, setSlashRecentNames] = useState<string[]>([]);

  // File picker state
  const [fileItems, setFileItems] = useState<FileNode[]>([]);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [fileFilter, setFileFilter] = useState("");
  const [fileSelected, setFileSelected] = useState<FileNode | null>(null);

  // Permission mode — per-session sticky, falls back to global default
  const [permissionMode, setPermissionMode] = useState<string | undefined>(
    (metadata?.permissionMode as string) ?? undefined,
  );

  // Pending message to send after WS connects (replaces unreliable setTimeout)
  const pendingSendRef = useRef<{ content: string; permissionMode?: string } | null>(null);

  // Drag-and-drop state
  const [isDragging, setIsDragging] = useState(false);
  const [externalFiles, setExternalFiles] = useState<File[] | null>(null);
  const [externalPaths, setExternalPaths] = useState<string[] | null>(null);
  const [disambiguateItems, setDisambiguateItems] = useState<FileNode[] | null>(null);
  const dragCounterRef = useRef(0);

  // Use tab's own project, not global activeProject (keep-alive: hidden tabs must not react to switches)
  const projectName = (metadata?.projectName as string) ?? "";
  const updateTab = useTabStore((s) => s.updateTab);
  const version = useSettingsStore((s) => s.version);

  // Usage runs independently — auto-refreshes on interval
  const { usageInfo, usageLoading, lastFetchedAt, refreshUsage } =
    useUsage(projectName, providerId);

  // Load global default permission mode on mount (if no per-session override)
  useEffect(() => {
    if (permissionMode) return;
    getAISettings().then((s) => {
      const provider = s.providers[s.default_provider ?? "claude"];
      setPermissionMode(provider?.permission_mode ?? "bypassPermissions");
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist sessionId, providerId, and permissionMode to tab metadata
  useEffect(() => {
    if (!tabId || !sessionId) return;
    updateTab(tabId, {
      metadata: { ...metadata, sessionId, providerId, permissionMode },
    });
  }, [sessionId, providerId, permissionMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const {
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
    sendMessage,
    respondToApproval,
    cancelStreaming,
    reconnect,
    refetchMessages,
    isConnected,
    teamActivity,
    teamMessages,
    markTeamRead,
  } = useChat(sessionId, providerId, projectName);

  // Flush pending message once WS connects (replaces unreliable setTimeout)
  useEffect(() => {
    if (isConnected && pendingSendRef.current) {
      const { content, permissionMode: pm } = pendingSendRef.current;
      pendingSendRef.current = null;
      sendMessage(content, { permissionMode: pm });
    }
  }, [isConnected, sendMessage]);

  // Auto-clear notification badge when this tab is active and document is visible.
  // Handles the case where notification arrived while browser tab was hidden.
  useEffect(() => {
    if (!sessionId || !tabId) return;
    const maybeClear = () => {
      if (document.hidden) return;
      const { panels, focusedPanelId } = usePanelStore.getState();
      const panel = panels[focusedPanelId];
      if (panel?.activeTabId === tabId) {
        useNotificationStore.getState().clearForSession(sessionId);
      }
    };
    maybeClear();
    document.addEventListener("visibilitychange", maybeClear);
    const unsub = usePanelStore.subscribe(maybeClear);
    return () => {
      document.removeEventListener("visibilitychange", maybeClear);
      unsub();
    };
  }, [sessionId, tabId]);

  // Update tab title when SDK summary arrives
  useEffect(() => {
    if (tabId && sessionTitle) {
      updateTab(tabId, { title: sessionTitle });
    }
  }, [sessionTitle]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pending fork message — show in input for user to edit, not auto-send
  const [forkDraft, setForkDraft] = useState<string | undefined>(metadata?.pendingMessage as string | undefined);
  useEffect(() => {
    if (forkDraft && isConnected && sessionId && tabId) {
      // Clear from tab metadata once consumed
      updateTab(tabId, { metadata: { ...metadata, pendingMessage: undefined } });
    }
  }, [isConnected, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleNewSession = useCallback(() => {
    useTabStore.getState().openTab({
      type: "chat",
      title: "AI Chat",
      metadata: { projectName, providerId },
      projectId: projectName || null,
      closable: true,
    });
  }, [projectName, providerId]);

  const handleSelectSession = useCallback((session: SessionInfo) => {
    setSessionId(session.id);
    setProviderId(session.providerId);
    if (tabId) updateTab(tabId, { title: session.title || "Chat" });
  }, [tabId, updateTab]);

  /** Fork current session and open new tab with the forked session, resending userMessage */
  const handleFork = useCallback(async (userMessage: string, messageId?: string) => {
    if (!sessionId || !projectName) return;
    try {
      const { api, projectUrl } = await import("@/lib/api-client");
      const forked = await api.post<{ id: string; forkedFrom: string }>(
        `${projectUrl(projectName)}/chat/sessions/${sessionId}/fork?providerId=${providerId}`,
        { messageId },
      );
      // Open new chat tab with forked session — it will send userMessage on connect
      useTabStore.getState().openTab({
        type: "chat",
        title: `Fork: ${userMessage.slice(0, 30)}`,
        metadata: { projectName, sessionId: forked.id, providerId, pendingMessage: userMessage },
        projectId: projectName || null,
        closable: true,
      });
    } catch (e) {
      console.error("Fork failed:", e);
    }
  }, [sessionId, projectName, providerId]);

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
    async (content: string, attachments: ChatAttachment[] = [], priority?: MessagePriority) => {
      const fullContent = buildMessageWithAttachments(content, attachments);
      if (!fullContent.trim()) return;

      if (!sessionId) {
        try {
          const pName = projectName;
          const session = await api.post<Session>(`${projectUrl(pName)}/chat/sessions`, {
            providerId,
            title: content.slice(0, 50),
          });
          setSessionId(session.id);
          setProviderId(session.providerId);
          // Queue message — will be sent by effect when WS reports isConnected
          pendingSendRef.current = { content: fullContent, permissionMode };
          return;
        } catch (e) {
          console.error("Failed to create session:", e);
          return;
        }
      }
      sendMessage(fullContent, { permissionMode, priority });
    },
    [sessionId, providerId, projectName, sendMessage, buildMessageWithAttachments, permissionMode],
  );

  /** Stable wrapper for MessageInput onSend — clears forkDraft and delegates to handleSend */
  const handleInputSend = useCallback(
    (content: string, attachments: ChatAttachment[], priority?: MessagePriority) => {
      setForkDraft(undefined);
      handleSend(content, attachments, priority);
    },
    [handleSend],
  );

  /** Stable callback for slash items loaded — prevents MessageInput memo break */
  const handleSlashItemsLoaded = useCallback(
    (items: SlashItem[], ranked?: boolean, recentNames?: string[]) => {
      setSlashItems(items);
      if (ranked !== undefined) setSlashRanked(ranked);
      if (recentNames) setSlashRecentNames(recentNames);
    },
    [],
  );

  // --- Slash picker handlers ---
  const handleSlashStateChange = useCallback((visible: boolean, filter: string) => {
    setShowSlashPicker(visible);
    setSlashFilter(filter);
    if (!visible || !filter) setSlashRanked(false);
  }, []);

  const handleSlashSelect = useCallback((item: SlashItem) => {
    setSlashSelected(item);
    setShowSlashPicker(false);
    setSlashFilter("");
    setTimeout(() => setSlashSelected(null), 50);
    // Record usage for recents (fire-and-forget)
    if (projectName) {
      api.post(`${projectUrl(projectName)}/chat/slash-recents`, { name: item.name, type: item.type }).catch(() => {});
      // Optimistic update: add to front of recents
      setSlashRecentNames((prev) => [item.name, ...prev.filter((n) => n !== item.name)].slice(0, 5));
    }
  }, [projectName]);

  const handleSlashClose = useCallback(() => {
    setShowSlashPicker(false);
    setSlashFilter("");
  }, []);

  // --- Disambiguation picker handler (OS drag resolve with multiple matches) ---
  const handleDisambiguate = useCallback((matches: FileNode[]) => {
    setDisambiguateItems(matches);
  }, []);

  const handleDisambiguateSelect = useCallback((item: FileNode) => {
    setExternalPaths([item.path]);
    setDisambiguateItems(null);
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
    if (e.dataTransfer.types.includes("application/x-ppm-path") || e.dataTransfer.types.includes("Files")) {
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

    // Check for internal file tree drag (custom MIME) first
    const ppmPath = e.dataTransfer.getData("application/x-ppm-path");
    if (ppmPath) {
      setExternalPaths([ppmPath]);
      return;
    }

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

      {/* Reconnect overlay */}
      {isReconnecting && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span>Reconnecting...</span>
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
        phase={phase}
        connectingElapsed={connectingElapsed}
        statusMessage={statusMessage}
        compactStatus={compactStatus}
        projectName={projectName}
        onFork={!isStreaming ? handleFork : undefined}
        onSelectSession={handleSelectSession}
      />

      {/* Bottom toolbar */}
      <div className="border-t border-border bg-background shrink-0">
        {/* Unified toolbar: History, Config, Usage, Bug report, Connection */}
        <ChatHistoryBar
          projectName={projectName}
          usageInfo={usageInfo}
          usageLoading={usageLoading}
          refreshUsage={refreshUsage}
          lastFetchedAt={lastFetchedAt}
          sessionId={sessionId}
          providerId={providerId}
          onSelectSession={handleSelectSession}
          onBugReport={sessionId ? () => openBugReportPopup(version, { sessionId, projectName }) : undefined}
          isConnected={isConnected}
          onReconnect={() => {
            if (!isConnected) reconnect();
            refetchMessages();
          }}
          teamActivity={teamActivity}
          teamMessages={teamMessages}
          onTeamOpen={markTeamRead}
        />

        {/* Pickers (in-flow, above input — only one visible at a time) */}
        <SlashCommandPicker
          items={slashItems}
          filter={slashFilter}
          onSelect={handleSlashSelect}
          onClose={handleSlashClose}
          visible={showSlashPicker}
          ranked={slashRanked}
          recentNames={slashRecentNames}
          projectName={projectName}
        />
        <FilePicker
          items={fileItems}
          filter={fileFilter}
          onSelect={handleFileSelect}
          onClose={handleFileClose}
          visible={showFilePicker}
        />
        {disambiguateItems && (
          <FilePicker
            items={disambiguateItems}
            filter=""
            onSelect={handleDisambiguateSelect}
            onClose={() => setDisambiguateItems(null)}
            visible={true}
          />
        )}

        {/* Input */}
        <MessageInput
          onSend={handleInputSend}
          isStreaming={isStreaming}
          onCancel={cancelStreaming}
          autoFocus={!(metadata?.sessionId) || !!forkDraft}
          initialValue={forkDraft}
          projectName={projectName}
          onSlashStateChange={handleSlashStateChange}
          onSlashItemsLoaded={handleSlashItemsLoaded}
          slashSelected={slashSelected}
          onFileStateChange={handleFileStateChange}
          onFileItemsLoaded={setFileItems}
          fileSelected={fileSelected}
          externalFiles={externalFiles}
          externalPaths={externalPaths}
          onExternalPathsConsumed={() => setExternalPaths(null)}
          onDisambiguate={handleDisambiguate}
          permissionMode={permissionMode}
          onModeChange={setPermissionMode}
          providerId={providerId}
          onProviderChange={!sessionId ? setProviderId : undefined}
        />
      </div>

      {/* Bug report popup is now global — see BugReportPopup in app.tsx */}
    </div>
  );
}
