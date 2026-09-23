import { useState, useCallback, useRef, useEffect } from "react";
import { Loader2, Upload, X } from "@/lib/icons";
import { toast } from "sonner";
import { api, projectUrl } from "@/lib/api-client";
import { selectInlineImages } from "@/lib/image-resize-limits";
import { splitAttachmentMarkers } from "@/lib/attachment-marker-split";
import type { ChatAttemptEvent } from "@/lib/chat-attempt-lifecycle";
import { useChat } from "@/hooks/use-chat";
import { useUsage } from "@/hooks/use-usage";
import { useTabStore } from "@/stores/tab-store";
import { useSettingsStore } from "@/stores/settings-store";
import { usePanelStore } from "@/stores/panel-store";
import { useNotificationStore } from "@/stores/notification-store";
import { openBugReportPopup } from "@/lib/report-bug";
import { getAISettings, pickAccountForTab } from "@/lib/api-settings";
import { MessageList } from "./message-list";
import { BackgroundCommandBar } from "./background-command-bar";
import { TeamWorkingBar } from "./team-working-bar";
import { McpSignInBar } from "@/components/mcp-auth/mcp-sign-in-bar";
import { useTeamActivityFeed } from "@/hooks/use-team-activity-feed";
import { MessageInput, type ChatAttachment, type MessagePriority } from "./message-input";
import { SlashCommandPicker, type SlashItem } from "./slash-command-picker";
import { FilePicker } from "./file-picker";
import { ChatHistoryBar } from "./chat-history-bar";
import { NewChatProviderGate } from "./new-chat-provider-gate";
import { useDraft, type DraftAttachment } from "@/hooks/use-draft";

import type { DragEvent } from "react";
import type { FileNode } from "../../../types/project";
import type { Session, SessionInfo } from "../../../types/chat";

interface ChatTabProps {
  metadata?: Record<string, unknown>;
  tabId?: string;
}

/**
 * How long a first message may wait for its session to be created, and then for the
 * new socket to report connected, before it is handed back to the user. Generous
 * because a codex app-server cold start alone takes ~30 s; the point is only that
 * "forever, silently" is not an option.
 */
const SESSION_CREATE_TIMEOUT_MS = 30_000;
const PENDING_SEND_TIMEOUT_MS = 45_000;

export function ChatTab({ metadata, tabId }: ChatTabProps) {
  return tabId && metadata ? (
    <NewChatProviderGate tabId={tabId} metadata={metadata}>
      <ChatTabContent metadata={metadata} tabId={tabId} />
    </NewChatProviderGate>
  ) : <ChatTabContent metadata={metadata} tabId={tabId} />;
}

function ChatTabContent({ metadata, tabId }: ChatTabProps) {
  const [sessionId, setSessionId] = useState<string | null>(
    (metadata?.sessionId as string) ?? null,
  );

  /**
   * Follow the session id when the provider adopts its own.
   *
   * PPM creates a session under a uuid it mints, then codex (or the Claude SDK)
   * reports the real id and the server re-keys to it. Everything written from
   * that point — transcript, title, account binding — lands under the new id, so
   * a tab left holding the original would reopen into an empty conversation even
   * though the history is on disk. Setting it here also persists it to the tab's
   * metadata through the effect below, which is what makes the fix survive a
   * reload rather than only lasting the turn.
   */
  const handleSessionMigrated = useCallback((newSessionId: string) => {
    setSessionId(newSessionId);
  }, []);
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

  // Pending message to send after WS connects (replaces unreliable setTimeout).
  // `draftId` is the draft it was composed under, deleted only once the message has
  // really been handed to the socket; until then that row is the only other copy.
  const pendingSendRef = useRef<{
    content: string;
    draftId: string;
    permissionMode?: string;
    images?: Array<{ data: string; mediaType: string }>;
    imagePaths?: string[];
  } | null>(null);
  const pendingSendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Usage runs independently — auto-refreshes on interval. Scoped to this session so the
  // account shown is the one bound to it, not whichever session ran most recently.
  const { usageInfo, usageLoading, lastFetchedAt, refreshUsage, reloadUsage } =
    useUsage(projectName, providerId, sessionId ?? undefined,
      metadata?.pickedAccountProvider === providerId ? metadata?.pickedAccountId as string | undefined : undefined);

  // Draft auto-save/restore
  const { draft, draftLoading, saveDraft, clearDraft, cancelPendingSave } = useDraft(projectName, sessionId);

  // Load global default permission mode on mount (if no per-session override)
  useEffect(() => {
    if (permissionMode) return;
    getAISettings().then((s) => {
      const provider = s.providers[providerId];
      setPermissionMode(provider?.permission_mode ?? "bypassPermissions");
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist sessionId, providerId, and permissionMode to tab metadata.
  //
  // The claimed account is dropped at the same moment: once a session exists, its binding
  // is the only account that matters, and it is the one the server re-routes when an
  // account goes bad. Keeping the tab's copy alongside it would give the chip a second,
  // staler answer to the same question.
  useEffect(() => {
    if (!tabId || !sessionId) return;
    updateTab(tabId, {
      metadata: {
        ...metadata,
        sessionId,
        providerId,
        permissionMode,
        pickedAccountId: undefined,
        pickedAccountLabel: undefined,
        pickedAccountProvider: undefined,
      },
    });
  }, [sessionId, providerId, permissionMode]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The tab's icon is this provider's logo, and the effect above only persists
   * the provider once a session exists — which is after the provider can no
   * longer be changed. Without this, a Codex or Cursor chat wears the Claude
   * logo for as long as its first message is being written.
   */
  const handleProviderChange = useCallback((id: string) => {
    setProviderId(id);
    if (tabId) updateTab(tabId, { metadata: { ...metadata, providerId: id } });
  }, [tabId, metadata, updateTab]);

  /** The account this tab claimed while it had no session yet, and who it was claimed from. */
  const pickedAccountId = metadata?.pickedAccountId as string | undefined;
  const pickedAccountLabel = metadata?.pickedAccountLabel as string | undefined;
  const pickedAccountProvider = metadata?.pickedAccountProvider as string | undefined;
  // A tab with no session can still switch provider, and accounts do not cross that line.
  // Without this the claim from the old provider survives the switch and the chip names a
  // Codex account on a Claude chat — confidently, and wrongly.
  const claimMatchesProvider = Boolean(pickedAccountId) && pickedAccountProvider === providerId;

  /**
   * Claim an account the moment the tab opens, instead of at the first message.
   *
   * A tab with no session has no WebSocket and no row anywhere, so there is nothing
   * server-side to hang this on. The tab's own metadata is the natural home: it is
   * persisted with the panel layout, so the claim survives a reload, and it is discarded
   * with the tab, which is exactly the lifetime asked for.
   *
   * Guarded on `pickedAccountId` being absent, not merely on having no session. Without
   * that, every reload would claim a fresh account and the tab would keep changing its
   * mind about who is answering. The claim is consumed — several tabs opened in a row
   * deliberately spread across the pool, and are allowed to collide.
   */
  useEffect(() => {
    if (!tabId || sessionId || claimMatchesProvider) return;
    let cancelled = false;
    pickAccountForTab(providerId)
      .then((picked) => {
        if (cancelled || !picked) return;
        updateTab(tabId, {
          metadata: {
            ...metadata,
            pickedAccountId: picked.id,
            pickedAccountLabel: picked.label,
            pickedAccountProvider: providerId,
          },
        });
      })
      .catch(() => { /* leave the chip blank rather than naming an account we did not get */ });
    return () => { cancelled = true; };
  }, [tabId, sessionId, providerId, claimMatchesProvider]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Move this chat onto an account the user picked in the panel.
   *
   * Two destinations, one for each half of a tab's life. Before the first message there is
   * no session, so the choice replaces the tab's claim and is redeemed when the session is
   * created. After that the session's binding is the only thing that decides, so it is
   * written directly. Both end up in the same place — this is the same path the automatic
   * route uses, not a parallel one.
   */
  const handleSelectAccount = useCallback(async (accountId: string, label: string | null): Promise<string | null> => {
    if (sessionId) {
      try {
        await api.put(`${projectUrl(projectName)}/chat/sessions/${sessionId}/account`, { accountId });
        // Say it locally too. The panel marks the serving card from this state, and the only
        // other source is the usage endpoint on a two-minute poll — so without this the badge
        // sits on the old account long after the switch, which reads as the button not working.
        setServingAccount({ id: accountId, label });
        // The header chip reports the account BOUND to this session, and that binding has
        // just changed — so re-read it now instead of leaving the chip on the previous
        // account's figures for up to the two-minute poll. Before the first message a
        // session has no binding at all, so those figures were blank, and the chip sat at
        // "--%" beside a panel already showing the chosen account's quota.
        void reloadUsage();
        // Switching costs a full prompt-cache write, so it is worth saying out loud rather
        // than letting the chip quietly change.
        toast.success("This chat will use the selected account from the next message.");
      } catch (e) {
        // Returned rather than toasted: the panel shows it beside the cards, which is where
        // the user just clicked and where the account they picked is still on screen.
        return (e as Error).message || "Could not switch account";
      }
      return null;
    }
    if (!tabId) return null;
    updateTab(tabId, {
      metadata: { ...metadata, pickedAccountId: accountId, pickedAccountLabel: label, pickedAccountProvider: providerId },
    });
    return null;
  }, [sessionId, projectName, tabId, metadata, providerId, updateTab, reloadUsage]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The account this chat is on, as far as the UI can tell.
   *
   * One piece of state with two writers, and last write wins — which is the right answer
   * chronologically. The stream writes it whenever a turn reports who served (including a
   * forced switch), and the manual picker writes it the moment the server accepts a choice.
   * Deriving it instead from the polled usage endpoint is what made the badge lag two
   * minutes behind a switch the user had just made.
   */
  const [servingAccount, setServingAccount] = useState<{ id: string; label: string | null } | null>(null);

  const tourTabActive = usePanelStore((state) => Object.values(state.panels).some((panel) => panel.activeTabId === tabId));
  const observeAttempt = useCallback((event: ChatAttemptEvent) => {
    if (!tabId) return;
    const visible = !document.hidden && Object.values(usePanelStore.getState().panels).some((panel) => panel.activeTabId === tabId);
    const types = { started: "chat-started", succeeded: "chat-succeeded", failed: "chat-failed", session: "chat-session" } as const;
    window.dispatchEvent(new CustomEvent("ppm:onboarding-evidence", {
      detail: { ...event, type: types[event.type], projectName, tabId, visible },
    }));
  }, [projectName, tabId]);

  const {
    messages,
    renderedMessages,
    expandCompact,
    isCompactExpanded,
    dismissMessage,
    clearErrors,
    messagesLoading,
    versionMap,
    isStreaming,
    phase,
    isReconnecting,
    connectingElapsed,
    pendingApproval,
    contextWindowPct,
    compactStatus,
    mcpNeedsAuth,
    statusMessage,
    sessionTitle,
    liveAccount,
    model,
    setModel,
    effort,
    setEffort,
    thinking,
    setThinking,
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
  } = useChat(sessionId, providerId, projectName, handleSessionMigrated, observeAttempt);

  useEffect(() => {
    if (!tabId || !tourTabActive || draftLoading || isStreaming) return;
    const announce = () => window.dispatchEvent(new CustomEvent("ppm:onboarding-evidence", {
      detail: { type: "chat-opened", projectName, tabId, sessionId, visible: !document.hidden },
    }));
    announce();
    window.addEventListener("ppm:onboarding-refresh", announce);
    return () => window.removeEventListener("ppm:onboarding-refresh", announce);
  }, [tabId, projectName, sessionId, tourTabActive, draftLoading, isStreaming]);

  // The stream's report is the second writer. A turn that ran — or was forced onto another
  // account mid-flight — is ground truth, and it arrives after whatever the picker last said.
  useEffect(() => {
    if (liveAccount) setServingAccount(liveAccount);
  }, [liveAccount]);

  // Automatic rotation keeps the same session id, so useUsage's polling scope
  // does not change. Re-read its binding as soon as the stream names an account.
  const liveAccountId = liveAccount?.id;
  useEffect(() => {
    if (liveAccountId) void reloadUsage();
  }, [liveAccountId, reloadUsage]);

  // A different conversation has a different account; carrying this one's over would label
  // it wrongly until the next turn corrected it.
  useEffect(() => { setServingAccount(null); }, [sessionId]);


  // Teammates keep working long after their spawn card scrolled away — a resume
  // arrives by SendMessage and writes no card at all. Poll the roster whenever this
  // session has a team so the working bar below the conversation stays truthful.
  const primaryTeam = teamActivity?.teamNames?.[0] ?? "";
  const { members: teamMembers } = useTeamActivityFeed(primaryTeam, !!primaryTeam);

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
  // True from the moment an edit is submitted until the forked session starts
  // responding. Drives a "working" indicator so the ~10s fork + codex connect
  // doesn't leave the user staring at a frozen screen. (No optimistic message
  // echo — appending it to the still-visible source transcript would render the
  // edit in the wrong place; the real message appears once the fork loads.)
  const [editForking, setEditForking] = useState(false);

  /**
   * A message that could not be sent, on its way back into the composer. A nonce
   * rather than the bare string: the text is often identical to the draft the
   * composer was prefilled with, and a value that does not change applies nothing.
   */
  const [restore, setRestore] = useState<{ text: string; nonce: number } | null>(null);

  /**
   * Give an unsent message back to the user.
   *
   * The composer empties itself the moment Enter is pressed, and the first send of a
   * new tab still has a session to create and a socket to open before anything leaves
   * the browser. Whichever of those fails, the text goes back into the input — the
   * composer re-saves it as the draft so a reload keeps it — and the failure is said
   * out loud: a cleared input over an unchanged transcript reads as nothing having
   * happened at all.
   *
   * What comes back is the full message as it would have been sent, attachment
   * markers included. The files themselves are already uploaded and the markers name
   * them, so re-sending still hands the model every file; the composer has no way to
   * re-attach them as chips, and a picture-only message would otherwise come back as
   * nothing at all.
   */
  const restoreUnsentMessage = useCallback((content: string, reason: string) => {
    setRestore({ text: content, nonce: Date.now() });
    toast.error("Message not sent", { description: `${reason} Your text is back in the input.` });
  }, []);

  /**
   * Drop a pending send that never got its socket; hand the text back.
   *
   * The draft it was composed under is cleared first: the composer re-saves the
   * restored text under the session the tab is on now, and leaving the old row
   * behind would prefill the next new tab with this message as well.
   */
  const abandonPendingSend = useCallback((reason: string) => {
    if (pendingSendTimerRef.current) { clearTimeout(pendingSendTimerRef.current); pendingSendTimerRef.current = null; }
    setEditForking(false);
    const pending = pendingSendRef.current;
    if (!pending) return;
    pendingSendRef.current = null;
    clearDraft(pending.draftId);
    restoreUnsentMessage(pending.content, reason);
  }, [restoreUnsentMessage, clearDraft]);

  /**
   * Queue a message for the moment the (new) session's socket reports connected.
   * Bounded: a socket that never says hello would otherwise keep the text in a ref
   * with nothing on screen, for as long as the tab lives.
   */
  const queuePendingSend = useCallback((pending: NonNullable<typeof pendingSendRef.current>) => {
    pendingSendRef.current = pending;
    if (pendingSendTimerRef.current) clearTimeout(pendingSendTimerRef.current);
    pendingSendTimerRef.current = setTimeout(
      () => abandonPendingSend("The chat did not connect in time."),
      PENDING_SEND_TIMEOUT_MS,
    );
  }, [abandonPendingSend]);

  // Flush pending message once WS connects (replaces unreliable setTimeout)
  useEffect(() => {
    if (isConnected && pendingSendRef.current) {
      const { content, draftId, permissionMode: pm, images: pendingImages, imagePaths: pendingPaths } = pendingSendRef.current;
      pendingSendRef.current = null;
      if (pendingSendTimerRef.current) { clearTimeout(pendingSendTimerRef.current); pendingSendTimerRef.current = null; }
      sendMessage(content, { permissionMode: pm, ...(pendingImages?.length && { images: pendingImages }), ...(pendingPaths?.length && { imagePaths: pendingPaths }) });
      clearDraft(draftId);
    }
  }, [isConnected, sendMessage, clearDraft]);

  // A closed tab takes its pending message with it; the timer must not fire into an
  // unmounted component.
  useEffect(() => () => {
    if (pendingSendTimerRef.current) clearTimeout(pendingSendTimerRef.current);
  }, []);
  // Pending edit: when set, the next send forks at `anchorMsgId` and continues
  // in THIS tab (swap sessionId) instead of opening a new tab.
  // anchorMsgId = fork anchor (prev message); ownMsgId = the edited message itself (for highlight).
  const [editFork, setEditFork] = useState<{ anchorMsgId?: string; ownMsgId?: string } | null>(null);
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

  const handleNewSession = useCallback((title?: string, clearedFrom?: string) => {
    useTabStore.getState().openTab({
      type: "chat",
      title: title || "AI Chat",
      metadata: { projectName, providerId, ...(clearedFrom && { clearedFrom }) },
      projectId: projectName || null,
      closable: true,
    });
  }, [projectName, providerId]);

  const handleSelectSession = useCallback((session: SessionInfo) => {
    // A message still waiting for its own session's socket must not ride the
    // connect of the one picked here: `isConnected` is session-scoped, so the flush
    // would fire on the selected conversation and post it there.
    abandonPendingSend("You switched to another chat before it connected.");
    setSessionId(session.id);
    setProviderId(session.providerId);
    if (tabId) updateTab(tabId, { title: session.title || "Chat" });
    // Immediately clear notification for the selected session
    useNotificationStore.getState().clearForSession(session.id);
  }, [tabId, updateTab, abandonPendingSend]);

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
        // Bounded like session creation below, and with the same accepted cost: a
        // fork the server finished after the abort is a stray sibling in the tree.
        const forked = await api.post<{ id: string }>(
          `${projectUrl(projectName)}/chat/sessions/${sessionId}/fork?providerId=${providerId}&mode=edit`,
          { messageId: anchorMsgId },
          { signal: AbortSignal.timeout(SESSION_CREATE_TIMEOUT_MS) },
        );
        // The tree gained a sibling. Swapping sessionId below refetches
        // /messages, which carries a fresh versionMap, so the switcher's n/m
        // counts update without any cache to invalidate.
        // Queue the edited message — flushed by the connect effect once the WS
        // reconnects to the forked session. The draft was composed under the
        // source session, so that is the one to clear when it goes.
        queuePendingSend({ content: fullContent, draftId: sessionId, permissionMode });
        // Swap the current tab to the forked session (no new tab).
        setStaleSwap(true);
        if (tabId) updateTab(tabId, { metadata: { ...metadata, sessionId: forked.id } });
        setSessionId(forked.id);
      } catch (e) {
        setEditForking(false);
        const msg = (e as Error)?.name === "TimeoutError"
          ? "The server did not answer in time."
          : (e as Error)?.message || "Unknown error";
        toast.error("Cannot edit from this message", {
          description: msg.includes("not found") || msg.includes("Invalid upToMessageId")
            ? "The original message is no longer available in the session transcript."
            : msg,
        });
        // The edited text was cleared from the composer on Enter — put it back.
        setRestore({ text: fullContent, nonce: Date.now() });
      }
    },
    [sessionId, projectName, providerId, permissionMode, tabId, updateTab, metadata, queuePendingSend],
  );

  /** Swap THIS tab to another version's session (version switcher prev/next) */
  const handleSwitchVersion = useCallback(
    (targetSessionId: string) => {
      if (!targetSessionId || targetSessionId === sessionId) return;
      // Same as handleSelectSession: a queued edit must not land in the version switched to.
      abandonPendingSend("You switched to another version before it connected.");
      setStaleSwap(true);
      if (tabId) updateTab(tabId, { metadata: { ...metadata, sessionId: targetSessionId } });
      setSessionId(targetSessionId);
    },
    [sessionId, tabId, updateTab, metadata, abandonPendingSend],
  );

  /** Build message content with file references and inline text snippets prepended */
  const buildMessageWithAttachments = useCallback(
    (
      content: string,
      attachments: ChatAttachment[],
      inlineImages: Array<{ data: string; mediaType: string }> = [],
    ): string => {
      if (attachments.length === 0) return content;

      const parts: string[] = [];

      // Inline text snippets (e.g. terminal output)
      for (const att of attachments) {
        if (att.textContent) parts.push(att.textContent);
      }

      // Server-uploaded file references. An image keeps its path even when the payload rides
      // along with the message, because the transcript is what the chat re-renders from and
      // the path is the only thing in it a thumbnail can be drawn from.
      //
      // An image sent inline says so in the marker. A bare path in a user message reads as an
      // invitation to open it, and a model that takes it pays for the same picture twice —
      // once inline, once as a tool result, both replayed on every later turn.
      //
      // Which marker an image gets follows the payloads that are actually going out, not
      // `imageData` alone: the per-message caps can leave one behind, and announcing that its
      // contents are included would hand the model neither the picture nor a reason to open
      // the file. `inlineImages` defaults to none, so a caller that sends no payloads at all
      // (the edit-fork path takes only text) gets the plain markers throughout.
      const { inlineImagePaths, pathOnlyPaths } = splitAttachmentMarkers(attachments, inlineImages);
      for (const path of inlineImagePaths) {
        parts.push(`[Attached image (contents included in this message): ${path}]`);
      }
      if (pathOnlyPaths.length > 0) {
        const fileRefs = pathOnlyPaths.join("\n");
        parts.push(
          pathOnlyPaths.length === 1
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
      const images = selectInlineImages(attachments);
      const fullContent = buildMessageWithAttachments(content, attachments, images);
      // Providers that take a file rather than a payload (codex) read these instead.
      const imagePaths = attachments.filter((a) => a.isImage && a.serverPath).map((a) => a.serverPath!);
      if (!fullContent.trim() && images.length === 0) return;

      if (!sessionId) {
        try {
          const pName = projectName;
          // Bounded: the composer is already empty by now, and a create call that hangs
          // (a stale tunnel connection after a long idle is the usual way) would otherwise
          // leave it empty over an unchanged transcript for as long as the tab lives.
          // Accepted cost: a create the server completed after the abort leaves one empty
          // session behind, which the retry does not reuse.
          const session = await api.post<Session>(`${projectUrl(pName)}/chat/sessions`, {
            providerId,
            title: content.slice(0, 50),
            // Set by /clear — the session only exists now, so persist the lineage here.
            clearedFrom: metadata?.clearedFrom as string | undefined,
            // The account this tab claimed on open and has been displaying since. Redeeming
            // it here is what makes that display true rather than a guess.
            accountId: pickedAccountId,
          }, { signal: AbortSignal.timeout(SESSION_CREATE_TIMEOUT_MS) });
          setSessionId(session.id);
          setProviderId(session.providerId);
          // Queue message — will be sent by effect when WS reports isConnected. It was
          // composed under the new-tab draft, which is what to clear once it goes.
          queuePendingSend({ content: fullContent, draftId: "__new__", permissionMode, images, imagePaths });
          return;
        } catch (e) {
          console.error("Failed to create session:", e);
          const msg = (e as Error)?.name === "TimeoutError"
            ? "The server did not answer in time."
            : `Could not start the chat: ${(e as Error)?.message || "unknown error"}.`;
          restoreUnsentMessage(fullContent, msg);
          return;
        }
      }
      sendMessage(fullContent, { permissionMode, priority, ...(images.length > 0 && { images }), ...(imagePaths.length > 0 && { imagePaths }) });
      // Only now: the message is on (or queued for) a live session's socket.
      clearDraft();
    },
    [sessionId, providerId, projectName, sendMessage, buildMessageWithAttachments, permissionMode, metadata, pickedAccountId, queuePendingSend, restoreUnsentMessage, clearDraft],
  );

  // Read through a ref so handleInputSend keeps a stable identity — it is passed to
  // the memoized MessageInput, and slashItems changes once the picker list loads.
  const slashItemsRef = useRef(slashItems);
  slashItemsRef.current = slashItems;

  /**
   * Stable wrapper for MessageInput onSend — drops the prefill and delegates.
   *
   * The draft is NOT deleted here. The composer has already emptied itself, so the
   * saved draft is the only other copy of the text until the send actually happens;
   * each send path deletes it at the moment the message reaches a socket, and puts
   * the text back when it cannot. Only the save still waiting on its debounce is
   * dropped, or it would land under whichever session the tab is on a second later.
   */
  const handleInputSend = useCallback(
    (content: string, attachments: ChatAttachment[], priority?: MessagePriority) => {
      // Client-handled built-ins act on the UI, so they must not reach the SDK.
      const slash = content.trim().match(/^\/(\S+)(?:\s+([\s\S]+))?$/);
      if (slash) {
        const item = slashItemsRef.current.find(
          (i) => i.handler === "client" && (i.name === slash[1] || i.aliases?.includes(slash[1]!)),
        );
        if (item?.name === "clear") {
          clearDraft();
          handleNewSession(slash[2]?.trim(), sessionId ?? undefined);
          return;
        }
      }

      setForkDraft(undefined);
      cancelPendingSave();
      if (editFork && sessionId && projectName) {
        const anchor = editFork.anchorMsgId;
        setEditFork(null);
        void handleEditSend(buildMessageWithAttachments(content, attachments), anchor);
        return;
      }
      void handleSend(content, attachments, priority);
    },
    [handleSend, clearDraft, cancelPendingSave, editFork, sessionId, projectName, handleEditSend, buildMessageWithAttachments, handleNewSession],
  );

  // Past user messages for the composer's ArrowUp/Down recall. Read through a ref
  // so the getter identity stays stable — `messages` changes on every stream chunk,
  // and a fresh array each time would break MessageInput's memo().
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const getUserHistory = useCallback(
    () =>
      messagesRef.current
        .filter((m) => m.role === "user" && m.content.trim())
        .map((m) => m.content),
    [],
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
      data-onboarding="chat"
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
        versionMap={versionMap}
        onSelectSession={handleSelectSession}
        onDismissMessage={dismissMessage}
        onClearErrors={clearErrors}
        bashPartialOutput={bashPartialOutput}
      />

      {/* Teammates still working — pinned here so it is the last thing under the conversation */}
      <TeamWorkingBar teamName={primaryTeam} members={teamMembers} projectName={projectName} />

      {/* MCP servers this session cannot use until someone signs in */}
      <McpSignInBar key={sessionId ?? "draft"} needsAuth={mcpNeedsAuth} projectName={projectName || undefined} />

      {/* Bottom toolbar */}
      <div className="border-t border-border bg-panel shrink-0">
        {/* Unified toolbar: History, Config, Usage, Bug report, Connection */}
        <ChatHistoryBar
          tabId={tabId}
          projectName={projectName}
          usageInfo={usageInfo}
          usageLoading={usageLoading}
          refreshUsage={refreshUsage}
          lastFetchedAt={lastFetchedAt}
          sessionId={sessionId}
          providerId={providerId}
          pickedAccountLabel={servingAccount?.label ?? (claimMatchesProvider ? pickedAccountLabel : null)}
          pickedAccountId={servingAccount?.id ?? (claimMatchesProvider ? pickedAccountId ?? null : null)}
          onSelectAccount={handleSelectAccount}
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
            draftReady={!draftLoading}
            tabId={tabId}
            onSend={handleInputSend}
            isStreaming={isStreaming}
            onCancel={cancelStreaming}
            autoFocus={!(metadata?.sessionId) || !!forkDraft}
            initialValue={forkDraft ?? draft?.content}
            clearSignal={clearInputSignal}
            restore={restore}
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
            getUserHistory={getUserHistory}
            permissionMode={permissionMode}
            onModeChange={setPermissionMode}
            providerId={providerId}
            sessionId={sessionId ?? undefined}
            onProviderChange={!sessionId ? handleProviderChange : undefined}
            model={model}
            onModelChange={setModel}
            effort={effort}
            onEffortChange={setEffort}
            thinking={thinking}
            onThinkingChange={setThinking}
          />
        )}
      </div>

      {/* Bug report popup is now global — see BugReportPopup in app.tsx */}
    </div>
  );
}
