import { usePanelStore } from "@/stores/panel-store";
import { useProjectStore } from "@/stores/project-store";
import { useState, useRef, useCallback, useEffect, memo, type KeyboardEvent, type DragEvent, type ClipboardEvent } from "react";
import { ArrowUp, Square, Paperclip, Loader2, Mic, MicOff, Bot, X } from "@/lib/icons";
import { useVoiceInput } from "@/hooks/use-voice-input";
import { useWhisperVoiceInput } from "@/hooks/use-whisper-voice-input";
import { useSettingsStore } from "@/stores/settings-store";
import { api, projectUrl, getAuthToken } from "@/lib/api-client";
import { downscaleImage } from "@/lib/image-resize";
import { INLINE_IMAGE_LIMITS } from "@/lib/image-resize-limits";
import { randomId } from "@/lib/utils";
import { ownsGlobalShortcut } from "@/lib/owns-global-shortcut";
import { SEND_TO_CHAT_EVENT, SEND_TO_CHAT_ACK_EVENT, type SendToChatAck, type SendToChatDetail } from "@/lib/send-to-chat";
import { isImageFile } from "@/lib/file-support";
import { AttachmentChips } from "./attachment-chips";
import { stepHistory } from "./message-history-recall";
import { toComposerDraft } from "../../../shared/user-message-parse";
import { ModeSelector, getModeLabel, getModeIcon, getModeShortLabel } from "./mode-selector";
import { ModelThinkingSelector } from "./model-thinking-selector";
import type { SlashItem } from "./slash-command-picker";
import { fetchSlashItems, getCachedSlashItems, subscribeSlashItems, SLASH_ITEMS_TTL_MS } from "@/lib/slash-items-cache";
import { replaceSlashQuery, slashQueryBefore, stripSlashQuery } from "@/lib/slash-trigger";
import type { FileNode } from "../../../types/project";
import { useFileStore } from "@/stores/file-store";
import { ReplyCard } from "./reply-card";
import type { ReplyReference } from "../../../shared/chat-reply";
import { ComposerTurnRefRow } from "./composer-turn-ref-row";
import type { ComposerTurnChip } from "@/hooks/use-composer-turn-refs";
import type { ParsedTurnLink } from "@/lib/turn-link";
import type { TurnReference } from "../../../shared/chat-turn-ref";
import { decodeMessageBlocks } from "../../../shared/chat-message-blocks";
import { insertLikeTyping, pasteWithoutTurnLinks } from "./composer-turn-link-paste";
import { PromptCacheChip } from "./prompt-cache-chip";
import type { PromptCacheState } from "../../../shared/prompt-cache-idle";
import type { EffortStatus } from "../../../shared/effort-status";

/**
 * Base64 payload for an image file, or undefined when it cannot be read.
 *
 * Reads through FileReader rather than assembling the string by hand: a phone photo is
 * millions of characters, and building it in chunks on the main thread freezes the composer
 * for as long as it takes.
 */
async function readImageData(file: File): Promise<{ data: string; mediaType: string } | undefined> {
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const comma = dataUrl.indexOf(",");
    const data = comma >= 0 ? dataUrl.slice(comma + 1) : "";
    return data ? { data, mediaType: file.type || "image/png" } : undefined;
  } catch {
    return undefined;
  }
}

export interface ChatAttachment {
  id: string;
  name: string;
  file: File;
  isImage: boolean;
  previewUrl?: string;
  /** Server-side path after upload */
  serverPath?: string;
  /** Inline text content (e.g. terminal output) — no upload needed */
  textContent?: string;
  /**
   * Base64 payload for an image, sent as part of the message itself.
   *
   * Passing the path instead would make the model spend a whole extra round trip calling Read
   * to fetch it, and every round trip re-sends the entire transcript. The uploaded copy is
   * still kept, so removing the payload from a transcript later stays recoverable.
   */
  imageData?: { data: string; mediaType: string };
  /** Dimensions before and after downscaling, when one happened — surfaced in the chip. */
  resized?: { from: { width: number; height: number }; to: { width: number; height: number } };
  status: "uploading" | "ready" | "error";
}


interface MessageInputProps {
  /** Rendered after the mode chip: the chat's workflow (Spec mode). */
  workflowSlot?: React.ReactNode;
  /** Rendered under the permission modes in the Modes menu; `close` shuts the menu. */
  modeMenuFooter?: (close: () => void) => React.ReactNode;
  pendingContexts?: Array<{ text: string; label?: string }>;
  onContextsConsumed?: () => void;
  draftReady?: boolean;
  replyTo?: ReplyReference | null;
  onCancelReply?: () => void;
  /** A reply or turn-chip change by the user: saves the current DOM text and attachments. */
  replyChangeSignal?: number;
  /** Turn chips from pasted turn links, shown above the input. */
  turnChips?: readonly ComposerTurnChip[];
  /**
   * Turn links found in pasted text; returns the ones there was no room for, which the paste
   * keeps as text. The links taken are inserted as chips only.
   */
  onTurnLinksPasted?: (links: ParsedTurnLink[]) => readonly ParsedTurnLink[];
  /** History recall put a past message in the input: these are its chips (null for none). */
  onRecallTurnRefs?: (refs: TurnReference[] | null) => void;
  onRemoveTurnChip?: (key: string) => void;
  /** Why the send waits on the turn chips (one still loading, one gone); null when it does not. */
  turnChipsBlockedReason?: string | null;
  /** Tab id of the owning chat tab — addresses "Send to Chat" at this tab only. */
  tabId?: string;
  /** `sendNow`: Ctrl/Cmd+Enter — while the AI works, have it read the queue at once. */
  onSend: (content: string, attachments: ChatAttachment[], opts?: { sendNow?: boolean }) => boolean | void;
  /** Ctrl/Cmd+Enter in an empty box while messages are queued (Claude Code's Send now). */
  onSendNow?: () => void;
  isStreaming?: boolean;
  onCancel?: () => void;
  disabled?: boolean;
  /** Input is usable while provider-dependent controls are still preparing. */
  configurationPending?: boolean;
  projectName?: string;
  /** Slash picker state change */
  onSlashStateChange?: (visible: boolean, filter: string) => void;
  onSlashItemsLoaded?: (items: SlashItem[], recentNames?: string[]) => void;
  slashSelected?: SlashItem | null;
  /** File picker state change */
  onFileStateChange?: (visible: boolean, filter: string) => void;
  onFileItemsLoaded?: (items: FileNode[]) => void;
  fileSelected?: FileNode | null;
  /** External files added via drag-drop on parent */
  externalFiles?: File[] | null;
  /** External paths from file tree drag or disambiguation */
  externalPaths?: string[] | null;
  /** Callback when external paths have been consumed (inserted into textarea) */
  onExternalPathsConsumed?: () => void;
  /** Callback when OS-dropped files resolve to multiple matches (disambiguation needed) */
  onDisambiguate?: (matches: FileNode[]) => void;
  /** Pre-fill input value (e.g. from command palette "Ask AI") */
  initialValue?: string;
  initialAttachments?: Array<{ name: string; path: string }>;
  /** Bumping this counter clears the textarea (e.g. parent cancels an edit). */
  clearSignal?: number;
  /**
   * A message that could not be sent, handed back. A fresh `nonce` applies it even
   * when `text` equals the last one — `initialValue` cannot do this, because it only
   * reacts to a *changed* value, and the text of a failed send is often exactly the
   * draft the composer was already prefilled with.
   */
  restore?: { text: string; nonce: number; replace?: boolean } | null;
  /** Called on content change for draft auto-save */
  onContentChange?: (content: string, attachments?: Array<{ name: string; path: string }>) => void;
  /** Returns this session's user messages, oldest first — powers ArrowUp/Down recall */
  getUserHistory?: () => string[];
  /** Auto-focus textarea on mount */
  autoFocus?: boolean;
  /** Current permission mode */
  permissionMode?: string;
  /** Permission mode change handler */
  onModeChange?: (mode: string) => void;
  /** Current provider ID */
  providerId?: string;
  /** Live session id, when the tab has one. Scopes the slash list to the session's
   *  own skill runtime (codex resolves skills per account home + project cwd). */
  sessionId?: string;
  /** Provider change handler — undefined when session is active (locked) */
  onProviderChange?: (providerId: string) => void;
  /** Current per-session model (null = provider default) */
  model?: string | null;
  /** Model change handler — undefined when no active session */
  onModelChange?: (model: string) => void;
  /** Current per-session effort (null = provider default) */
  effort?: string | null;
  /** What overrides the effort pick outside PPM (CLAUDE_CODE_EFFORT_LEVEL, a settings cap, the model) */
  effortStatus?: EffortStatus | null;
  /** Effort change handler */
  onEffortChange?: (effort: string) => void;
  /** Current per-session thinking on/off */
  thinking?: boolean;
  /** Thinking toggle handler */
  onThinkingChange?: (enabled: boolean) => void;
  /** This session's prompt-cache clock: a cold cache is shown beside the mic. */
  promptCache?: PromptCacheState | null;
  /** The chat is reconnecting or offline: what is sent now waits for the connection. */
  offline?: boolean;
}

export const MessageInput = memo(function MessageInput({
  workflowSlot,
  modeMenuFooter,
  tabId,
  pendingContexts,
  onContextsConsumed,
  replyTo,
  onCancelReply,
  replyChangeSignal,
  turnChips,
  onTurnLinksPasted,
  onRecallTurnRefs,
  onRemoveTurnChip,
  turnChipsBlockedReason,
  draftReady = true,
  onSend,
  onSendNow,
  isStreaming,
  onCancel,
  disabled,
  projectName,
  onSlashStateChange,
  onSlashItemsLoaded,
  slashSelected,
  onFileStateChange,
  onFileItemsLoaded,
  fileSelected,
  externalFiles,
  externalPaths,
  onExternalPathsConsumed,
  initialValue,
  initialAttachments,
  clearSignal,
  restore,
  onContentChange,
  getUserHistory,
  autoFocus,
  permissionMode,
  onModeChange,
  providerId,
  sessionId,
  onProviderChange,
  model,
  onModelChange,
  effort,
  effortStatus,
  onEffortChange,
  thinking,
  onThinkingChange,
  promptCache,
  offline = false,
  configurationPending = false,
}: MessageInputProps) {
  // Uncontrolled textarea: value lives in DOM + ref, not React state.
  // Only `hasText` state triggers re-renders (empty↔non-empty for send button).
  // This eliminates React re-render on every keystroke — critical for Chromium on iPad.
  const valueRef = useRef(initialValue ?? "");
  const [hasText, setHasText] = useState(() => (initialValue ?? "").trim().length > 0);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  // Selected subagent — rendered as a removable chip, prepended as natural
  // language on send so the model delegates via the Task tool.
  const [agentTag, setAgentTag] = useState<string | null>(null);
  const [modeSelectorOpen, setModeSelectorOpen] = useState(false);
  const [pendingSend, setPendingSend] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mobileTextareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const slashItemsRef = useRef<SlashItem[]>([]);
  const fileItemsRef = useRef<FileNode[]>([]);
  const resizeRafRef = useRef(0);
  // Track picker open state to avoid unnecessary parent callbacks per keystroke
  const slashPickerOpenRef = useRef(false);
  const filePickerOpenRef = useRef(false);
  // CSS field-sizing: content handles auto-resize natively (Safari 18.2+, Chrome 123+).
  // Only fall back to JS scrollHeight resize when unsupported.
  const needsJsResize = useRef(
    typeof CSS === "undefined" || !CSS.supports("field-sizing", "content"),
  );

  // File index: subscribe imperatively to avoid re-renders on every file store update.
  // The component only needs fileIndex for the effect below (populating fileItemsRef),
  // not for rendering — so we use Zustand's subscribe() instead of selector hooks.

  /** Write value to both textareas + ref + update hasText state */
  const writeTextareas = useCallback((newValue: string) => {
    valueRef.current = newValue;
    if (textareaRef.current) textareaRef.current.value = newValue;
    if (mobileTextareaRef.current) mobileTextareaRef.current.value = newValue;
    setHasText(newValue.trim().length > 0);
  }, []);

  /** Get the currently visible textarea */
  const getVisibleTextarea = useCallback(() => {
    return window.matchMedia("(min-width: 768px)").matches
      ? textareaRef.current
      : mobileTextareaRef.current;
  }, []);

  // Shell-style history recall. Counts back from the newest user message
  // (0 = newest); -1 means not browsing, so the input holds a live draft.
  const historyIdxRef = useRef(-1);

  /** Step through past user messages. Returns false when the step is out of range. */
  const recallHistory = useCallback(
    (delta: number) => {
      const step = stepHistory(getUserHistory?.() ?? [], historyIdxRef.current, delta);
      if (!step) return false;
      historyIdxRef.current = step.index;
      // Recalled content still carries its send-time wrappers — unwrap it back
      // into what was typed, with the delegated agent restored as a chip.
      const { agent, text } = toComposerDraft(step.text);
      setAgentTag(agent);
      writeTextareas(text);
      if (replyTo) onCancelReply?.();
      // Its turn references come back as chips, before the draft save below reads them.
      onRecallTurnRefs?.(step.text ? decodeMessageBlocks(step.text).turnRefs : null);
      onContentChange?.(text, attachments.filter((a) => a.status === "ready" && a.serverPath).map((a) => ({ name: a.name, path: a.serverPath! })));
      const ta = getVisibleTextarea();
      if (!ta) return true;
      ta.focus();
      requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = text.length; });
      if (needsJsResize.current) {
        ta.style.height = "auto";
        ta.style.height = Math.min(ta.scrollHeight, ta === mobileTextareaRef.current ? 80 : 160) + "px";
      }
      return true;
    },
    [getUserHistory, writeTextareas, getVisibleTextarea, replyTo, onCancelReply, onRecallTurnRefs, onContentChange, attachments],
  );

  // Voice input. Two engines behind the same button: the browser's own
  // recogniser (text appears as you speak, but Chrome/Edge/Safari only) and
  // Whisper running on the PPM host (any browser, answers once at the end).
  // Settings picks, per device; an engine the device cannot do falls back.
  const voiceEngine = useSettingsStore((s) => s.voiceEngine);
  const browserVoice = useVoiceInput();
  const whisperVoice = useWhisperVoiceInput();
  const useWhisper = voiceEngine === "whisper" && whisperVoice.supported;
  const voice = useWhisper ? whisperVoice : browserVoice;
  const isTranscribing = useWhisper && whisperVoice.isTranscribing;
  // Store pre-voice text so voice appends to existing input
  const preVoiceTextRef = useRef("");
  const voiceResultCb = useCallback((text: string) => {
    const prefix = preVoiceTextRef.current;
    const newValue = prefix ? prefix + " " + text : text;
    writeTextareas(newValue);
    // Auto-resize textarea (only when CSS field-sizing is unsupported)
    if (needsJsResize.current) {
      requestAnimationFrame(() => {
        const ta = getVisibleTextarea();
        if (ta) {
          ta.style.height = "auto";
          ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
        }
      });
    }
  }, [writeTextareas, getVisibleTextarea]);
  const handleVoiceToggle = useCallback(() => {
    // The shortcut reaches this while Whisper is still working on the last
    // recording, where the button is already disabled.
    if (isTranscribing) return;
    if (voice.isListening) {
      voice.stop();
    } else {
      preVoiceTextRef.current = valueRef.current.trim();
      voice.start(voiceResultCb);
    }
  }, [voice.isListening, voice.start, voice.stop, voiceResultCb, isTranscribing]);

  const micLabel = isTranscribing
    ? "Transcribing"
    : voice.isListening ? "Stop voice input" : "Start voice input";

  // Listen for global keyboard shortcut (Cmd+Shift+V) to toggle voice.
  // Guarded so that only the focused panel's chat reacts — every chat tab stays
  // mounted, so an unguarded listener toggles the mic in all of them at once.
  useEffect(() => {
    const handler = () => {
      if (!voice.supported) return;
      if (!ownsGlobalShortcut(getVisibleTextarea())) return;
      handleVoiceToggle();
    };
    window.addEventListener("toggle-voice-input", handler);
    return () => window.removeEventListener("toggle-voice-input", handler);
  }, [voice.supported, handleVoiceToggle, getVisibleTextarea]);

  // "Send to Chat" (terminal output, other tabs) — add as an attachment chip.
  // Every chat tab stays mounted, so the event is addressed: only the tab it names
  // may consume it, or the same output lands in every open chat at once.
  useEffect(() => {
    const handler = (e: Event) => {
      const { text, label, targetTabId, autoSend } = ((e as CustomEvent).detail ?? {}) as SendToChatDetail;
      if (!text) return;
      if (targetTabId ? targetTabId !== tabId : !ownsGlobalShortcut(getVisibleTextarea())) return;
      // Sent as-is only into an idle, empty composer: anything the user has typed or
      // attached is theirs, and the text joins it as a chip for them to send instead.
      const send = !!autoSend && !!targetTabId && !disabled && !isStreaming && !replyTo && !turnChips?.length && !valueRef.current.trim() && attachments.length === 0;
      window.dispatchEvent(new CustomEvent<SendToChatAck>(SEND_TO_CHAT_ACK_EVENT, { detail: { sent: send } }));
      if (send) {
        onSend(text, []);
        return;
      }
      const att: ChatAttachment = {
        id: randomId(),
        name: label ?? "Terminal output",
        file: new File([], "terminal-output.txt"),
        isImage: false,
        textContent: text,
        status: "ready",
      };
      setAttachments((prev) => [...prev, att]);
      getVisibleTextarea()?.focus();
    };
    window.addEventListener(SEND_TO_CHAT_EVENT, handler);
    return () => window.removeEventListener(SEND_TO_CHAT_EVENT, handler);
  }, [getVisibleTextarea, tabId, disabled, isStreaming, attachments.length, onSend, replyTo, turnChips]);

  const consumedContextsRef = useRef<MessageInputProps["pendingContexts"]>(undefined);
  useEffect(() => {
    if (!pendingContexts?.length || consumedContextsRef.current === pendingContexts) return;
    consumedContextsRef.current = pendingContexts;
    setAttachments((previous) => [...previous, ...pendingContexts.map(({ text, label }) => ({
      id: randomId(), name: label ?? "Selected code", file: new File([], "selected-code.txt"),
      isImage: false, textContent: text, status: "ready" as const,
    }))]);
    onContextsConsumed?.();
    getVisibleTextarea()?.focus();
  }, [pendingContexts, onContextsConsumed, getVisibleTextarea]);

  const draftAttachmentsApplied = useRef(false);
  useEffect(() => {
    if (!draftReady || draftAttachmentsApplied.current || initialAttachments === undefined) return;
    draftAttachmentsApplied.current = true;
    if (!initialAttachments?.length) return;
    const restored: ChatAttachment[] = initialAttachments.map((attachment) => ({
      id: randomId(), name: attachment.name, file: new File([], attachment.name),
      serverPath: attachment.path, isImage: isImageFile(new File([], attachment.name)), status: "ready",
    }));
    // Joined, never skipped: code added to a chat that had not mounted yet arrives before its
    // draft does, and a draft skipped here is saved back without its attachments.
    setAttachments((previous) => [...restored, ...previous]);
  }, [draftReady, initialAttachments]); // eslint-disable-line react-hooks/exhaustive-deps

  // Apply initialValue when it changes (e.g. "Ask AI" from command palette).
  // A restored draft can land after the input is already on screen, so never
  // write over text that is already there — what was typed wins.
  useEffect(() => {
    if (initialValue && !valueRef.current) {
      writeTextareas(initialValue);
      // Focus and move cursor to end
      const timer = setTimeout(() => {
        const ta = textareaRef.current;
        if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; }
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [initialValue]); // eslint-disable-line react-hooks/exhaustive-deps

  // A tour suggestion is an explicit user action. Hydrated or typed drafts always win.
  useEffect(() => {
    const suggest = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!draftReady || disabled || isStreaming || valueRef.current || attachments.length || agentTag || !tabId) return;
      if (detail?.projectName !== projectName || (detail.tabId && detail.tabId !== tabId) || typeof detail.text !== "string") return;
      const panels = usePanelStore.getState();
      const active = detail.tabId
        ? Object.values(panels.panels).some((panel) => panel.activeTabId === tabId)
        : panels.panels[panels.focusedPanelId]?.activeTabId === tabId;
      if (!active || document.hidden) return;
      writeTextareas(detail.text);
      onContentChange?.(detail.text);
      getVisibleTextarea()?.focus();
    };
    window.addEventListener("ppm:onboarding-prompt", suggest);
    return () => window.removeEventListener("ppm:onboarding-prompt", suggest);
  }, [draftReady, disabled, isStreaming, attachments.length, agentTag, tabId, projectName, onContentChange, writeTextareas, getVisibleTextarea]);

  // Parent-driven clear (e.g. cancelling an edit) — skip initial mount (0).
  useEffect(() => {
    if (clearSignal) {
      writeTextareas("");
      draftAttachmentsApplied.current = false;
      for (const attachment of attachments) if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      setAttachments([]);
      setAgentTag(null);
    }
  }, [clearSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  // An unsent message coming back. The send can fail up to ~45 s after Enter, by which
  // time the user may be typing something new — so the text goes AFTER what is there
  // rather than over it. Reported as a content change so it is saved as the draft
  // again; `writeTextareas` alone tells nobody.
  useEffect(() => {
    if (!restore?.nonce || !restore.text) return;
    const current = valueRef.current;
    const next = !restore.replace && current.trim() ? `${current}\n\n${restore.text}` : restore.text;
    writeTextareas(next);
    onContentChange?.(next, attachments.filter((a) => a.status === "ready" && a.serverPath).map((a) => ({ name: a.name, path: a.serverPath! })));
    const timer = setTimeout(() => {
      const ta = getVisibleTextarea();
      if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; }
    }, 50);
    return () => clearTimeout(timer);
  }, [restore?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!replyChangeSignal) return;
    onContentChange?.(valueRef.current, attachments.filter((a) => a.status === "ready" && a.serverPath).map((a) => ({ name: a.name, path: a.serverPath! })));
    getVisibleTextarea()?.focus();
  }, [replyChangeSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-focus on mount when requested
  useEffect(() => {
    if (!autoFocus) return;
    const timer = setTimeout(() => { getVisibleTextarea()?.focus(); }, 100);
    return () => clearTimeout(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Reuse provider skills immediately and refresh project overrides in the background.
  const slashLoadRef = useRef(0);
  const loadSlashItems = useCallback(() => {
    const request = ++slashLoadRef.current;
    if (configurationPending) return;
    if (!projectName) {
      slashItemsRef.current = [];
      onSlashItemsLoaded?.([], []);
      return;
    }
    const cached = getCachedSlashItems(projectName, providerId);
    slashItemsRef.current = cached?.items ?? [];
    onSlashItemsLoaded?.(cached?.items ?? [], cached?.recentNames ?? []);
    fetchSlashItems(projectName, providerId, sessionId)
      .then((data) => {
        if (request !== slashLoadRef.current) return;
        slashItemsRef.current = data.items;
        onSlashItemsLoaded?.(data.items, data.recentNames);
      })
      .catch(() => { /* Keep usable skills when a refresh fails. */ });
  }, [projectName, providerId, sessionId, onSlashItemsLoaded, configurationPending]);

  useEffect(() => {
    loadSlashItems();
    const unsubscribe = subscribeSlashItems(() => {
      if (!projectName) return;
      const cached = getCachedSlashItems(projectName, providerId);
      if (cached && !configurationPending) {
        slashItemsRef.current = cached.items;
        onSlashItemsLoaded?.(cached.items, cached.recentNames);
      }
    });
    const timer = setInterval(loadSlashItems, SLASH_ITEMS_TTL_MS);
    return () => { ++slashLoadRef.current; unsubscribe(); clearInterval(timer); };
  }, [loadSlashItems, projectName, providerId, onSlashItemsLoaded, configurationPending]);

  // Warm the catalog on mount so the first slash interaction need not wait.

  // Refresh button invalidated the server cache — drop ours too, then refetch.
  useEffect(() => {
    const handler = () => {
      loadSlashItems();
    };
    window.addEventListener("ppm:slash-items-refresh", handler);
    return () => window.removeEventListener("ppm:slash-items-refresh", handler);
  }, [loadSlashItems, projectName]);

  // Sync file picker items from store index — subscribe imperatively to avoid re-renders.
  // Reads fileIndex on mount + whenever fileIndex/indexStatus changes in the store.
  useEffect(() => {
    const syncFromStore = () => {
      if (!projectName) {
        fileItemsRef.current = [];
        onFileItemsLoaded?.([]);
        return;
      }
      // Share the store's array rather than mapping it: every mounted chat tab runs this,
      // and a project index can hold tens of thousands of entries, so a per-tab copy
      // kept one full duplicate alive for each open chat. Consumers only read it.
      const files = useFileStore.getState();
      if (filePickerOpenRef.current && files.indexStatus === "idle" && useProjectStore.getState().activeProject?.name === projectName) {
        void files.loadIndex(projectName);
        return;
      }
      const nodes: FileNode[] = files.indexProject === projectName ? files.fileIndex : [];
      fileItemsRef.current = nodes;
      onFileItemsLoaded?.(nodes);
    };
    syncFromStore();
    // Track previous values to only sync on relevant changes
    let prevIdx = useFileStore.getState().fileIndex;
    let prevStatus = useFileStore.getState().indexStatus;
    return useFileStore.subscribe((state) => {
      if (state.fileIndex !== prevIdx || state.indexStatus !== prevStatus) {
        prevIdx = state.fileIndex;
        prevStatus = state.indexStatus;
        syncFromStore();
      }
    });
  }, [projectName]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle parent selecting a slash item
  useEffect(() => {
    if (!slashSelected) return;
    const el = getVisibleTextarea();
    if (!el) return;
    const text = el.value;
    const cursorPos = el.selectionStart;
    const textBefore = text.slice(0, cursorPos);
    const textAfter = text.slice(cursorPos);

    // Agents render as a removable chip (not inline text) so the composed
    // "Use the X agent to …" prompt is only assembled at send time.
    if (slashSelected.type === "agent") {
      const stripped = stripSlashQuery(textBefore);
      setAgentTag(slashSelected.name);
      writeTextareas(stripped + textAfter);
      onSlashStateChange?.(false, "");
      slashPickerOpenRef.current = false;
      el.focus();
      setTimeout(() => { el.selectionStart = el.selectionEnd = stripped.length; }, 0);
      return;
    }

    // Find the /query pattern before cursor and replace it with the command name.
    // The item's own sigil is used, not a hardcoded `/`: a codex skill is invoked
    // as `$imagegen`, so the composer must show the text that will actually be
    // sent rather than leaving the server to silently rewrite it.
    const replaced = replaceSlashQuery(textBefore, `${slashSelected.invokeSigil ?? "/"}${slashSelected.name}`);
    writeTextareas(replaced + textAfter);
    onSlashStateChange?.(false, "");
    slashPickerOpenRef.current = false;
    onFileStateChange?.(false, "");
    filePickerOpenRef.current = false;
    el.focus();
    setTimeout(() => {
      el.selectionStart = el.selectionEnd = replaced.length;
    }, 0);
  }, [slashSelected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle parent selecting a file
  useEffect(() => {
    if (!fileSelected) return;
    const el = getVisibleTextarea();
    if (!el) return;

    const text = el.value;
    const cursorPos = el.selectionStart;
    const textBefore = text.slice(0, cursorPos);
    const textAfter = text.slice(cursorPos);
    // Find the @ trigger before cursor
    const atMatch = textBefore.match(/@(\S*)$/);
    if (atMatch) {
      const start = textBefore.length - atMatch[0].length;
      const newText = textBefore.slice(0, start) + `@${fileSelected.path} ` + textAfter;
      writeTextareas(newText);
      const newCursorPos = start + fileSelected.path.length + 2; // +2 for @ and space
      setTimeout(() => {
        el.selectionStart = el.selectionEnd = newCursorPos;
        el.focus();
      }, 0);
    } else {
      // Fallback: append at end
      const newText = text + `@${fileSelected.path} `;
      writeTextareas(newText);
      setTimeout(() => {
        el.selectionStart = el.selectionEnd = newText.length;
        el.focus();
      }, 0);
    }
    onFileStateChange?.(false, "");
    filePickerOpenRef.current = false;
  }, [fileSelected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle external files dropped on parent (ChatTab)
  useEffect(() => {
    if (!externalFiles || externalFiles.length === 0) return;
    processFiles(externalFiles);
  }, [externalFiles]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle external paths from file tree drag or disambiguation
  useEffect(() => {
    if (!externalPaths || externalPaths.length === 0) return;
    const pathRefs = externalPaths.map((p) => `@${p}`).join(" ");
    const cur = valueRef.current;
    const sep = cur.length > 0 && !cur.endsWith(" ") ? " " : "";
    writeTextareas(cur + sep + pathRefs + " ");
    getVisibleTextarea()?.focus();
    onExternalPathsConsumed?.();
  }, [externalPaths]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Delete an upload the user removed before sending. Best effort — nothing depends on it. */
  const discardUpload = useCallback(
    async (serverPath: string) => {
      if (!projectName) return;
      const filename = serverPath.split(/[\\/]/).pop();
      if (!filename) return;
      try {
        const headers: HeadersInit = {};
        const token = getAuthToken();
        if (token) headers["Authorization"] = `Bearer ${token}`;
        await fetch(`${projectUrl(projectName)}/chat/uploads/${encodeURIComponent(filename)}`, {
          method: "DELETE",
          headers,
        });
      } catch {
        // An orphaned file is not worth surfacing to the user.
      }
    },
    [projectName],
  );

  /** Upload a single file to the server, return server path */
  const uploadFile = useCallback(
    async (file: File): Promise<string | null> => {
      if (!projectName) return null;
      try {
        const form = new FormData();
        form.append("files", file);
        const headers: HeadersInit = {};
        const token = getAuthToken();
        if (token) headers["Authorization"] = `Bearer ${token}`;
        const res = await fetch(`${projectUrl(projectName)}/chat/upload`, {
          method: "POST",
          headers,
          body: form,
        });
        const json = await res.json();
        if (json.ok && Array.isArray(json.data) && json.data.length > 0) {
          return json.data[0].path as string;
        }
        return null;
      } catch {
        return null;
      }
    },
    [projectName],
  );

  /** Process files — always uploads to server. Path resolution only happens via @ picker. */
  const processFiles = useCallback(
    async (files: File[]) => {
      for (const original of files) {
        const id = randomId();
        const isImg = isImageFile(original);

        const att: ChatAttachment = {
          id,
          name: original.name,
          file: original,
          isImage: isImg,
          previewUrl: isImg ? URL.createObjectURL(original) : undefined,
          status: "uploading",
        };

        setAttachments((prev) => [...prev, att]);

        // Shrink first, so the upload, the preview and the message all carry the same
        // already-reduced image — an oversized original must not reach the transcript.
        //
        // Only a `scaled` or `inlineable` result is attached inline. An image that could not
        // be measured or re-encoded travels by path alone: sending unverified dimensions
        // inline risks a payload the API refuses, and that refusal outlives the turn, since
        // the transcript replays it into every later one.
        try {
          const outcome = isImg ? await downscaleImage(original) : null;
          const file = outcome?.file ?? original;
          // Point the thumbnail at the reduced file and let the original go. It is the larger
          // of the two and nothing needs it once the resize is done, but it stayed alive until
          // the message was sent because the preview still referenced it.
          const previewUrl = isImg && file !== original ? URL.createObjectURL(file) : undefined;
          const serverPath = await uploadFile(file);
          const inlineable = outcome ? outcome.kind !== "asis" : false;
          const imageData = inlineable ? await readImageData(file) : undefined;
          const withinPayloadCap =
            !!imageData && imageData.data.length <= INLINE_IMAGE_LIMITS.maxBase64PerImage;

          if (previewUrl && att.previewUrl) URL.revokeObjectURL(att.previewUrl);
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === id
                ? {
                    ...a,
                    file,
                    ...(previewUrl && { previewUrl }),
                    serverPath: serverPath ?? undefined,
                    imageData: withinPayloadCap ? imageData : undefined,
                    resized: outcome?.to ? { from: outcome.from!, to: outcome.to } : undefined,
                    // An image can still be sent inline when the upload failed; anything
                    // else has nothing left to send without its path.
                    status: serverPath || withinPayloadCap ? "ready" : "error",
                  }
                : a,
            ),
          );
        } catch {
          // Nothing here may leave an attachment stuck on "uploading" — both the send button
          // and the auto-send effect wait on that state, so a swallowed throw hangs the composer.
          setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, status: "error" } : a)));
        }
      }
      (mobileTextareaRef.current ?? textareaRef.current)?.focus();
    },
    [uploadFile],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const att = prev.find((a) => a.id === id);
      if (att?.previewUrl) URL.revokeObjectURL(att.previewUrl);
      // Uploads are never swept, because chat history points at them indefinitely, so one
      // abandoned before it was ever sent would sit there with nothing referencing it.
      if (att?.serverPath) void discardUpload(att.serverPath);
      return prev.filter((a) => a.id !== id);
    });
    // Saved as the draft too: otherwise a reload restores a chip whose file was just deleted,
    // and the next message goes out naming it.
    onContentChange?.(valueRef.current, attachments.filter((a) => a.id !== id && a.status === "ready" && a.serverPath).map((a) => ({ name: a.name, path: a.serverPath! })));
  }, [discardUpload, onContentChange, attachments]);

  /** Ctrl/Cmd+Enter armed the send executed next (it may wait on an upload). */
  const sendNowRef = useRef(false);

  /** Execute the actual send (called directly or after uploads complete) */
  const executeSend = useCallback(() => {
    const trimmed = valueRef.current.trim();
    const readyAttachments = attachments.filter((a) => a.status === "ready");
    if (!trimmed && readyAttachments.length === 0 && !agentTag) {
      setPendingSend(false);
      return;
    }

    // Prepend the agent-delegation prompt; UserBubble re-parses this prefix back
    // into a chip for display.
    const content = agentTag ? `Use the ${agentTag} agent to ${trimmed}`.trimEnd() : trimmed;

    onSlashStateChange?.(false, "");
    slashPickerOpenRef.current = false;
    onFileStateChange?.(false, "");
    filePickerOpenRef.current = false;
    // Sending closes the mic. Whisper's recording is dropped rather than
    // transcribed: its text would arrive seconds later, into the box the
    // message just left.
    if (voice.isListening) {
      if (useWhisper) whisperVoice.cancel();
      else voice.stop();
    }
    const sendNow = sendNowRef.current;
    sendNowRef.current = false;
    if (onSend(content, readyAttachments, sendNow ? { sendNow } : undefined) === false) return;
    writeTextareas("");
    // Revoke preview URLs
    for (const att of attachments) {
      if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
    }
    setAttachments([]);
    setAgentTag(null);
    setPendingSend(false);
    historyIdxRef.current = -1;
    if (needsJsResize.current) {
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      if (mobileTextareaRef.current) mobileTextareaRef.current.style.height = "auto";
    }
  }, [attachments, agentTag, onSend, onSlashStateChange, onFileStateChange, writeTextareas,
      voice.isListening, voice.stop, whisperVoice.cancel, useWhisper]);

  const handleSend = useCallback(() => {
    if (disabled) return;
    // A turn chip still loading, or one whose turn is gone, would send a message that names
    // something it cannot carry; the reason is shown under the chips.
    if (turnChipsBlockedReason) return;

    // If files are still uploading, queue the send for when they finish
    if (attachments.some((a) => a.status === "uploading")) {
      const trimmed = valueRef.current.trim();
      if (trimmed || attachments.some((a) => a.status !== "error")) {
        setPendingSend(true);
      }
      return;
    }

    executeSend();
  }, [attachments, disabled, executeSend, turnChipsBlockedReason]);

  // Auto-send when queued and all uploads complete
  useEffect(() => {
    if (!pendingSend) return;
    if (attachments.some((a) => a.status === "uploading")) return;
    if (turnChipsBlockedReason) { setPendingSend(false); return; }
    executeSend();
  }, [pendingSend, attachments, executeSend, turnChipsBlockedReason]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const now = !!isStreaming && (e.ctrlKey || e.metaKey);
        if (now && !valueRef.current.trim() && attachments.length === 0 && !agentTag) {
          onSendNow?.();
          return;
        }
        sendNowRef.current = now;
        handleSend();
        return;
      }
      // History recall. Only starts from an empty input so ArrowUp keeps moving
      // the caret inside a multi-line draft. The slash/@ pickers swallow these
      // keys before they reach here while either one is open.
      // Bare arrows only — Alt+Arrow is the global chat-transcript jump.
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const browsing = historyIdxRef.current >= 0;
        // Turn chips make the input not empty: recall would replace them with the past message's.
        if (!browsing && (e.key === "ArrowDown" || valueRef.current !== "" || agentTag || turnChips?.length)) return;
        if (recallHistory(e.key === "ArrowUp" ? 1 : -1)) e.preventDefault();
        return;
      }
      // Shift+Tab: cycle permission mode
      if (e.shiftKey && e.key === "Tab") {
        e.preventDefault();
        const modeIds = ["default", "acceptEdits", "plan", "bypassPermissions"];
        const idx = modeIds.indexOf(permissionMode ?? "bypassPermissions");
        const next = modeIds[(idx + 1) % modeIds.length]!;
        onModeChange?.(next);
      }
    },
    [handleSend, permissionMode, onModeChange, recallHistory, agentTag, turnChips, isStreaming, attachments.length, onSendNow],
  );

  const updatePickerState = useCallback(
    (text: string, cursorPos: number) => {
      const textBefore = text.slice(0, cursorPos);

      // Fast path: if no trigger chars exist at all, skip regex + callbacks
      const hasSlash = textBefore.includes("/");
      const hasAt = textBefore.includes("@");
      if (!hasSlash && !hasAt) {
        // Close pickers only if they were actually open (avoid unnecessary parent setState)
        if (slashPickerOpenRef.current) { onSlashStateChange?.(false, ""); slashPickerOpenRef.current = false; }
        if (filePickerOpenRef.current) { onFileStateChange?.(false, ""); filePickerOpenRef.current = false; }
        return;
      }

      // Check for slash anywhere in text (after whitespace or at start)
      if (hasSlash) {
        const filter = slashQueryBefore(textBefore);
        if (filter !== null) {
          if (!slashPickerOpenRef.current) loadSlashItems();
          onSlashStateChange?.(true, filter);
          slashPickerOpenRef.current = true;
          if (filePickerOpenRef.current) { onFileStateChange?.(false, ""); filePickerOpenRef.current = false; }
          return;
        }
      }

      // Check for @ anywhere in text (after whitespace or at start)
      if (hasAt) {
        const atMatch = textBefore.match(/@(\S*)$/);
        if (atMatch) {
          // The index is refreshed only when something opens to read it — see `indexStale`.
          if (!filePickerOpenRef.current && projectName) useFileStore.getState().ensureIndex(projectName);
          onFileStateChange?.(true, atMatch[1] ?? "");
          filePickerOpenRef.current = true;
          if (slashPickerOpenRef.current) { onSlashStateChange?.(false, ""); slashPickerOpenRef.current = false; }
          return;
        }
      }

      // Nothing matched — close both pickers (only if open)
      if (slashPickerOpenRef.current) { onSlashStateChange?.(false, ""); slashPickerOpenRef.current = false; }
      if (filePickerOpenRef.current) { onFileStateChange?.(false, ""); filePickerOpenRef.current = false; }
    },
    [onSlashStateChange, onFileStateChange, loadSlashItems, projectName],
  );

  /** JS auto-resize fallback — only when CSS field-sizing: content is unsupported. */
  const scheduleResize = useCallback((el: HTMLTextAreaElement) => {
    if (!needsJsResize.current) return;
    if (resizeRafRef.current) cancelAnimationFrame(resizeRafRef.current);
    resizeRafRef.current = requestAnimationFrame(() => {
      resizeRafRef.current = 0;
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, el === mobileTextareaRef.current ? 80 : 160) + "px";
    });
  }, []);

  /** Unified onChange for both textareas — updates ref, syncs other textarea, triggers picker */
  const handleTextareaChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const el = e.target;
      const text = el.value;
      valueRef.current = text;
      // Typing turns a recalled message back into a live draft.
      historyIdxRef.current = -1;
      // Sync the other textarea (handles viewport rotation edge case)
      const other = el === textareaRef.current ? mobileTextareaRef.current : textareaRef.current;
      if (other) other.value = text;
      // Only trigger re-render on empty↔non-empty transition (for send button state)
      setHasText(text.trim().length > 0);
      // Update picker state (slash/file autocomplete)
      updatePickerState(text, el.selectionStart);
      // Notify parent for draft auto-save (debounced in hook)
      onContentChange?.(text, attachments.filter((a) => a.status === "ready" && a.serverPath).map((a) => ({ name: a.name, path: a.serverPath! })));
      scheduleResize(el);
    },
    [updatePickerState, onContentChange, attachments, scheduleResize],
  );

  /** Handle paste — intercept images from clipboard */
  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const files: File[] = [];
      for (const item of items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        processFiles(files);
        return;
      }
      // Turn links become chips; everything else in the paste goes in exactly as it was.
      const text = onTurnLinksPasted ? e.clipboardData.getData("text/plain") : "";
      if (!onTurnLinksPasted || !text || !text.includes("/project/")) return;
      const projects = new Set(useProjectStore.getState().projects.map((p) => p.name));
      const insert = pasteWithoutTurnLinks(text, (name) => projects.has(name), onTurnLinksPasted);
      if (insert === null) return;
      e.preventDefault();
      const ta = e.currentTarget;
      // Typed in by the browser, its `input` event runs handleTextareaChange as a keystroke does.
      if (insertLikeTyping(ta, insert)) return;
      const start = ta.selectionStart ?? ta.value.length;
      const next = ta.value.slice(0, start) + insert + ta.value.slice(ta.selectionEnd ?? start);
      writeTextareas(next);
      ta.selectionStart = ta.selectionEnd = start + insert.length;
      historyIdxRef.current = -1;
      onContentChange?.(next, attachments.filter((a) => a.status === "ready" && a.serverPath).map((a) => ({ name: a.name, path: a.serverPath! })));
      scheduleResize(ta);
    },
    [processFiles, onTurnLinksPasted, writeTextareas, onContentChange, attachments, scheduleResize],
  );

  const handleDragOver = useCallback((e: DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
  }, []);

  /** Open native file picker */
  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length > 0) processFiles(files);
      // Reset so same file can be selected again
      e.target.value = "";
    },
    [processFiles],
  );

  const hasContent = hasText || attachments.some((a) => a.status !== "error") || !!agentTag;
  const showCancel = isStreaming && !hasContent;
  const placeholder = offline ? "Will send when reconnected..." : isStreaming ? "Queue a message, or Stop..." : "Ask anything...";

  return (
    <div data-onboarding="chat-input">
      {/* Rounded input container */}
      <div
        className="cursor-text rounded-[18px] border border-border bg-panel shadow-[var(--shadow-float)] transition-[border-color] duration-150 focus-within:border-accent-wash-border"
        onClick={(e) => {
          if (disabled) return;
          // Only focus when clicking outside the textarea (e.g. padding area)
          if (e.target instanceof HTMLTextAreaElement) return;
          getVisibleTextarea()?.focus();
        }}
      >
        {replyTo && <div className="px-2 md:px-4 pt-2">
          <ReplyCard reply={replyTo} preview onCancel={onCancelReply} />
        </div>}
        {!!turnChips?.length && onRemoveTurnChip && (
          <ComposerTurnRefRow chips={turnChips} currentProject={projectName} blockedReason={turnChipsBlockedReason} onRemove={onRemoveTurnChip} />
        )}
        {/* Selected agent chip — composed into a delegation prompt on send */}
        {agentTag && (
          <div className="px-2 md:px-4 pt-2">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-xs font-medium text-sky-600 dark:text-sky-400">
              <Bot className="size-3.5 shrink-0" />
              {agentTag}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setAgentTag(null); getVisibleTextarea()?.focus(); }}
                className="shrink-0 rounded-sm p-0.5 hover:bg-sky-500/20 transition-colors"
                aria-label={`Remove ${agentTag} agent`}
              >
                <X className="size-3" />
              </button>
            </span>
          </div>
        )}
        {/* Attachment chips (inside container, aligned with input) */}
        <AttachmentChips attachments={attachments} onRemove={removeAttachment} />
        {/* The textarea on top — one per layout, since a phone keeps it shorter — and one bar below. */}
        <textarea
          ref={mobileTextareaRef}
          defaultValue={initialValue ?? ""}
          onChange={handleTextareaChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onDragOver={handleDragOver}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          aria-label="Message"
          className="block w-full resize-none bg-transparent px-3 pb-0 pt-2 text-sm leading-relaxed text-foreground placeholder:text-text-subtle focus:outline-none disabled:opacity-50 max-h-20 [field-sizing:content] md:hidden"
        />
        <textarea
          ref={textareaRef}
          defaultValue={initialValue ?? ""}
          onChange={handleTextareaChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onDragOver={handleDragOver}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          aria-label="Message"
          className="hidden w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-sm leading-relaxed text-foreground placeholder:text-text-subtle focus:outline-none disabled:opacity-50 max-h-[160px] min-h-12 [field-sizing:content] md:block"
        />

        {/* Attach, mode, model, Queue … cache, mic, send. Icons are 16px here (the ▾ is 12px);
            only the model chip shrinks, so a long model name ends in an ellipsis. */}
        <div className="flex min-w-0 items-center gap-1 px-2 pb-2 pt-1 @max-[420px]/chat:gap-0.5 @max-[420px]/chat:px-1.5 max-md:gap-0.5 max-md:px-1.5 max-md:pb-1 max-md:pt-0 [&>*]:shrink-0 [&>[data-model-slot]]:shrink">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleAttachClick(); }}
            disabled={disabled}
            className={SQUARE_BUTTON}
            aria-label="Attach file"
            title="Attach file"
          >
            <Paperclip className="size-4" />
          </button>
          {!configurationPending && (
            <div className="relative">
              <ModeChip
                mode={permissionMode ?? "bypassPermissions"}
                onClick={() => setModeSelectorOpen((v) => !v)}
              />
              <ModeSelector
                value={permissionMode ?? "bypassPermissions"}
                onChange={(m) => onModeChange?.(m)}
                open={modeSelectorOpen}
                onOpenChange={setModeSelectorOpen}
                footer={modeMenuFooter?.(() => setModeSelectorOpen(false))}
              />
            </div>
          )}
          {workflowSlot}
          {onModelChange && projectName && (
            <div data-model-slot="" className="flex min-w-0">
              <ModelThinkingSelector
                model={model ?? null}
                effort={effort ?? null}
                effortStatus={effortStatus}
                thinking={thinking ?? false}
                onModelChange={onModelChange}
                onEffortChange={onEffortChange ?? (() => {})}
                onThinkingChange={onThinkingChange ?? (() => {})}
                projectName={projectName}
                providerId={providerId ?? "claude"}
                disabled={isStreaming}
                onProviderChange={onProviderChange}
              />
            </div>
          )}
          <span className="min-w-1 flex-1 !shrink" />
          <PromptCacheChip promptCache={promptCache ?? null} />
          {voice.supported && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); handleVoiceToggle(); }}
              disabled={disabled || isTranscribing}
              className={voice.isListening ? `${SQUARE_BUTTON} !bg-error !text-white animate-pulse` : SQUARE_BUTTON}
              aria-label={micLabel}
              title={micLabel}
            >
              {isTranscribing
                ? <Loader2 className="size-4 animate-spin" />
                : voice.isListening ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            </button>
          )}
          {showCancel ? (
            <button
              onClick={(e) => { e.stopPropagation(); onCancel?.(); }}
              className="footer-fade-in flex size-9 items-center justify-center rounded-[11px] max-md:size-8 max-md:rounded-[10px] bg-error text-white shadow-[var(--shadow-float)] transition-[background-color,transform] duration-150 motion-safe:active:scale-[0.97] hover:bg-error/80"
              aria-label="Stop response"
              title="Stop"
            >
              <Square className="size-4" />
            </button>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); pendingSend ? setPendingSend(false) : handleSend(); }}
              disabled={disabled || !hasContent || !!turnChipsBlockedReason}
              className="flex size-9 items-center justify-center rounded-[11px] max-md:size-8 max-md:rounded-[10px] bg-primary text-primary-foreground shadow-[var(--shadow-float)] transition-[background-color,transform] duration-150 motion-safe:active:scale-[0.97] hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-30 disabled:shadow-none disabled:active:scale-100"
              aria-label={pendingSend ? "Cancel queued send" : "Send message"}
              title="Send"
            >
              {pendingSend ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
            </button>
          )}
        </div>
      </div>

      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileInputChange} />
    </div>
  );
});

/** The composer bar's square icon buttons: Attach and the mic. */
const SQUARE_BUTTON =
  "flex size-[34px] items-center justify-center rounded-[10px] text-text-3 transition-[background-color,color,transform] duration-150 motion-safe:active:scale-[0.97] can-hover:hover:bg-surface-hover can-hover:hover:text-text disabled:opacity-50 max-md:size-8";

/** A borderless chip of the composer bar: the mode and, while a turn runs, Queue. */
const BAR_CHIP =
  "inline-flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-full px-[9px] text-[11.5px] text-text-2 transition-[background-color,color,transform] duration-150 motion-safe:active:scale-[0.97] can-hover:hover:bg-surface-hover can-hover:hover:text-text @max-[420px]/chat:gap-1 @max-[420px]/chat:px-1.5 max-md:h-7 max-md:gap-1 max-md:px-1.5";

/** The permission mode in one word ("Bypass"), its icon alone on a narrow chat. */
function ModeChip({ mode, onClick }: { mode: string; onClick: () => void }) {
  const Icon = getModeIcon(mode);
  const label = getModeLabel(mode);
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={BAR_CHIP}
      aria-label={`Permission mode: ${label}`}
      title={`Permission mode: ${label}`}
    >
      <Icon className="size-4" />
      <span className="@max-[420px]/chat:hidden max-md:hidden">{getModeShortLabel(mode)}</span>
    </button>
  );
}

