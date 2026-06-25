import { useState, useCallback, useRef, useEffect } from "react";
import { Loader2, Upload, X } from "lucide-react";
import { toast } from "sonner";
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
import { BackgroundCommandBar } from "./background-command-bar";
import { clearVersionsCache } from "./version-switcher";
import { MessageInput, type ChatAttachment, type MessagePriority } from "./message-input";
import { SlashCommandPicker, type SlashItem } from "./slash-command-picker";
import { FilePicker } from "./file-picker";
import { ChatHistoryBar } from "./chat-history-bar";
import { useDraft, type DraftAttachment } from "@/hooks/use-draft";

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

  // Draft auto-save/restore
  const { draft, draftLoading, saveDraft, clearDraft } = useDraft(projectName, sessionId);

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
    renderedMessages,
    expandCompact,
    isCompactExpanded,
    dismissMessage,
    clearErrors,
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
    model,
    setModel,
    sendMessage,
    respondToApproval,
    cancelStreaming,
    reconnect,
    refetchMessages,
    isConnected,
    teamActivity,
    teamMessages,
    markTeamRead,
    bashPartialOutput,
    backgroundShells,
    killBackgroundShell,
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
  // Checks ALL panels (not just focused) so split-panel scenarios also clear.
  useEffect(() => {
    if (!sessionId || !tabId) return;
    const maybeClear = () => {
      if (document.hidden) return;
      const { panels } = usePanelStore.getState();
      const isActive = Object.values(panels).some((p) => p.activeTabId === tabId);
      if (!isActive) return;
      // Manual "mark as unread" stays sticky while the tab is active; only the explicit
      // clear-on-(re)select path (handleSelectSession / tab onSelect) clears it.
      if (useNotificationStore.getState().notifications.get(sessionId)?.manual) return;
      useNotificationStore.getState().clearForSession(sessionId);
    };
    maybeClear();
    document.addEventListener("visibilitychange", maybeClear);
    const unsub = usePanelStore.subscribe(maybeClear);
    // Also auto-clear when notification store changes (cross-tab broadcast may add for active session)
    const unsub2 = useNotificationStore.subscribe(maybeClear);
    return () => {
      document.removeEventListener("visibilitychange", maybeClear);
      unsub();
      unsub2();
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
  // Pending edit: when set, the next send forks at `anchorMsgId` and continues
  // in THIS tab (swap sessionId) instead of opening a new tab.
  // anchorMsgId = fork anchor (prev message); ownMsgId = the edited message itself (for highlight).
  const [editFork, setEditFork] = useState<{ anchorMsgId?: string; ownMsgId?: string } | null>(null);
  // Local echo of a just-sent edited message. The forked session's WS connect can
  // be slow (codex app-server cold start ~30s), and the real optimistic message is
  // only added after `isConnected`. Show this immediately so the edit doesn't
  // vanish while the new session spins up; cleared once the real message arrives.
  // True from the moment an edit is submitted until the forked session starts
  // responding. Drives a "working" indicator so the ~10s fork + codex connect
  // doesn't leave the user staring at a frozen screen. (No optimistic message
  // echo — appending it to the still-visible source transcript would render the
  // edit in the wrong place; the real message appears once the fork loads.)
  const [editForking, setEditForking] = useState(false);
  // Bumped to tell MessageInput to clear its textarea when an edit is cancelled.
  const [clearInputSignal, setClearInputSignal] = useState(0);
  // True while a same-tree version swap loads: versions share an identical prefix,
  // so we keep the stale transcript on screen (only the divergent tail visibly
  // changes) instead of flashing the full-screen loading state.
  const [staleSwap, setStaleSwap] = useState(false);
  const prevMsgsLoadingRef = useRef(false);
  useEffect(() => {
    // Reset only on the true→false transition — the swap render happens before
    // messagesLoading turns true, so resetting on any !loading would fire early.
    if (prevMsgsLoadingRef.current && !messagesLoading) setStaleSwap(false);
    prevMsgsLoadingRef.current = !!messagesLoading;
  }, [messagesLoading]);
  // Input mounts once the first draft load settles, then STAYS mounted across
  // same-tab session swaps — unmounting would flash and lose typed text.
  // Per-session drafts still apply via MessageInput's initialValue effect.
  const [inputReady, setInputReady] = useState(false);
  useEffect(() => {
    if (!draftLoading) setInputReady(true);
  }, [draftLoading]);
  useEffect(() => {
    if (forkDraft && isConnected && sessionId && tabId) {
      // Clear from tab metadata once consumed
      updateTab(tabId, { metadata: { ...metadata, pendingMessage: undefined } });
    }
  }, [isConnected, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stop the "working" indicator once the forked session begins streaming (its
  // own activity UI takes over). Safety timeout covers a connect that never
  // arrives so the spinner can't get stuck forever.
  useEffect(() => {
    if (editForking && isStreaming) setEditForking(false);
  }, [editForking, isStreaming]);
  useEffect(() => {
    if (!editForking) return;
    const t = setTimeout(() => setEditForking(false), 60_000);
    return () => clearTimeout(t);
  }, [editForking]);

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
    setEditForking(false);
    setSessionId(session.id);
    setProviderId(session.providerId);
    if (tabId) updateTab(tabId, { title: session.title || "Chat" });
    // Immediately clear notification for the selected session
    useNotificationStore.getState().clearForSession(session.id);
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
      // Backend returns 400 when upToMessageId is missing from source JSONL (ghost uuid
      // from interrupted streams, compaction edge cases). Surface to user instead of
      // silent failure / empty session.
      const msg = (e as Error)?.message || "Unknown error";
      toast.error("Cannot fork from this message", {
        description: msg.includes("not found") || msg.includes("Invalid upToMessageId")
          ? "The original message is no longer available in the session transcript. Try forking from a different message."
          : msg,
      });
    }
  }, [sessionId, projectName, providerId]);

  /** Edit a user message: prefill input + arm same-tab fork on next send */
  const handleEdit = useCallback((userMessage: string, messageId?: string, ownMsgId?: string) => {
    setForkDraft(userMessage);
    setEditFork({ anchorMsgId: messageId, ownMsgId });
  }, []);

  /** Abandon an armed edit: disarm the fork, drop the prefill, clear the input. */
  const handleCancelEdit = useCallback(() => {
    setEditFork(null);
    setForkDraft(undefined);
    setEditForking(false);
    clearDraft();
    setClearInputSignal((n) => n + 1);
  }, [clearDraft]);

  /** Fork at the edit anchor, swap THIS tab to the forked session, queue the edited message */
  const handleEditSend = useCallback(
    async (fullContent: string, anchorMsgId?: string) => {
      if (!fullContent.trim() || !sessionId || !projectName) return;
      // Surface a working indicator immediately — the fork API and the forked
      // session's codex connect can take ~10s; don't await in silence.
      setEditForking(true);
      try {
        const forked = await api.post<{ id: string }>(
          `${projectUrl(projectName)}/chat/sessions/${sessionId}/fork?providerId=${providerId}&mode=edit`,
          { messageId: anchorMsgId },
        );
        // The tree gained a sibling — drop cached version groups so switchers
        // refetch fresh n/m counts instead of showing stale numbers.
        clearVersionsCache();
        // Queue the edited message — flushed by the connect effect once the WS
        // reconnects to the forked session.
        pendingSendRef.current = { content: fullContent, permissionMode };
        // Swap the current tab to the forked session (no new tab).
        setStaleSwap(true);
        if (tabId) updateTab(tabId, { metadata: { ...metadata, sessionId: forked.id } });
        setSessionId(forked.id);
      } catch (e) {
        setEditForking(false);
        const msg = (e as Error)?.message || "Unknown error";
        toast.error("Cannot edit from this message", {
          description: msg.includes("not found") || msg.includes("Invalid upToMessageId")
            ? "The original message is no longer available in the session transcript."
            : msg,
        });
      }
    },
    [sessionId, projectName, providerId, permissionMode, tabId, updateTab, metadata],
  );

  /** Swap THIS tab to another version's session (version switcher prev/next) */
  const handleSwitchVersion = useCallback(
    (targetSessionId: string) => {
      if (!targetSessionId || targetSessionId === sessionId) return;
      setEditForking(false);
      setStaleSwap(true);
      if (tabId) updateTab(tabId, { metadata: { ...metadata, sessionId: targetSessionId } });
      setSessionId(targetSessionId);
    },
    [sessionId, tabId, updateTab, metadata],
  );

  /** Build message content with file references and inline text snippets prepended */
  const buildMessageWithAttachments = useCallback(
    (content: string, attachments: ChatAttachment[]): string => {
      if (attachments.length === 0) return content;

      const parts: string[] = [];

      // Inline text snippets (e.g. terminal output)
      for (const att of attachments) {
        if (att.textContent) parts.push(att.textContent);
      }

      // Server-uploaded file references
      const fileAtts = attachments.filter((a) => a.serverPath);
      if (fileAtts.length > 0) {
        const fileRefs = fileAtts.map((a) => a.serverPath!).join("\n");
        parts.push(
          fileAtts.length === 1
            ? `[Attached file: ${fileRefs}]`
            : `[Attached files:\n${fileRefs}\n]`,
        );
      }

      if (parts.length === 0) return content;
      return parts.join("\n\n") + "\n\n" + content;
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

  /** Stable wrapper for MessageInput onSend — clears forkDraft + draft and delegates to handleSend */
  const handleInputSend = useCallback(
    (content: string, attachments: ChatAttachment[], priority?: MessagePriority) => {
      setForkDraft(undefined);
      clearDraft();
      if (editFork && sessionId && projectName) {
        const anchor = editFork.anchorMsgId;
        setEditFork(null);
        void handleEditSend(buildMessageWithAttachments(content, attachments), anchor);
        return;
      }
      handleSend(content, attachments, priority);
    },
    [handleSend, clearDraft, editFork, sessionId, projectName, handleEditSend, buildMessageWithAttachments],
  );

  /** Draft auto-save callback — called by MessageInput on content change */
  const handleContentChange = useCallback(
    (content: string, attachments?: DraftAttachment[]) => {
      saveDraft(content, attachments);
    },
    [saveDraft],
  );

  /** Stable callback for slash items loaded — prevents MessageInput memo break */
  const handleSlashItemsLoaded = useCallback(
    (items: SlashItem[], recentNames?: string[]) => {
      setSlashItems(items);
      if (recentNames) setSlashRecentNames(recentNames);
    },
    [],
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

  // Stable callback: clear external paths once consumed (avoids inline lambda breaking MessageInput memo)
  const handleExternalPathsConsumed = useCallback(() => setExternalPaths(null), []);

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

      {/* Edit-fork overlay — covers the chat while the new version forks + connects */}
      {editForking && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span>Creating edited version…</span>
          </div>
        </div>
      )}

      {/* Background commands running for this session */}
      <BackgroundCommandBar shells={backgroundShells} onKill={killBackgroundShell} />

      {/* Messages */}
      <MessageList
        messages={renderedMessages}
        onExpandCompact={expandCompact}
        isCompactExpanded={isCompactExpanded}
        messagesLoading={messagesLoading}
        keepStaleWhileLoading={staleSwap}
        pendingApproval={pendingApproval}
        onApprovalResponse={respondToApproval}
        isStreaming={isStreaming}
        phase={phase}
        connectingElapsed={connectingElapsed}
        statusMessage={statusMessage}
        compactStatus={compactStatus}
        projectName={projectName}
        onFork={!isStreaming ? handleFork : undefined}
        onEdit={!isStreaming ? handleEdit : undefined}
        editingMsgId={editFork?.ownMsgId}
        sessionId={sessionId ?? undefined}
        providerId={providerId}
        onNavigateVersion={handleSwitchVersion}
        onSelectSession={handleSelectSession}
        onDismissMessage={dismissMessage}
        onClearErrors={clearErrors}
        bashPartialOutput={bashPartialOutput}
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
          onReload={() => {
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

        {/* Editing indicator — makes the armed edit state visible + cancellable */}
        {editFork && (
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs text-muted-foreground border-t border-border bg-muted/40">
            <span>Editing message — your next send replaces it</span>
            <button
              type="button"
              onClick={handleCancelEdit}
              className="flex items-center gap-1 rounded px-2 py-1 min-h-[28px] hover:bg-accent hover:text-accent-foreground transition-colors"
              title="Cancel edit (send as a new message instead)"
            >
              <X className="h-3.5 w-3.5" />
              Cancel
            </button>
          </div>
        )}

        {/* Input — gate on first draft load to avoid empty→filled flash, then keep mounted */}
        {(inputReady || !draftLoading) && (
          <MessageInput
            onSend={handleInputSend}
            isStreaming={isStreaming}
            onCancel={cancelStreaming}
            autoFocus={!(metadata?.sessionId) || !!forkDraft}
            initialValue={forkDraft ?? draft?.content}
            clearSignal={clearInputSignal}
            projectName={projectName}
            onSlashStateChange={handleSlashStateChange}
            onSlashItemsLoaded={handleSlashItemsLoaded}
            slashSelected={slashSelected}
            onFileStateChange={handleFileStateChange}
            onFileItemsLoaded={setFileItems}
            fileSelected={fileSelected}
            externalFiles={externalFiles}
            externalPaths={externalPaths}
            onExternalPathsConsumed={handleExternalPathsConsumed}
            onDisambiguate={handleDisambiguate}
            onContentChange={handleContentChange}
            permissionMode={permissionMode}
            onModeChange={setPermissionMode}
            providerId={providerId}
            onProviderChange={!sessionId ? setProviderId : undefined}
            model={model}
            onModelChange={setModel}
          />
        )}
      </div>

      {/* Bug report popup is now global — see BugReportPopup in app.tsx */}
    </div>
  );
}
