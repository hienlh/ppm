import { useState, useRef, useCallback, useEffect, memo, type KeyboardEvent, type DragEvent, type ClipboardEvent } from "react";
import { ArrowUp, Square, Paperclip, Loader2, Mic, MicOff, Zap, ListOrdered, Clock, Bot, X } from "lucide-react";
import { useVoiceInput } from "@/hooks/use-voice-input";
import { api, projectUrl, getAuthToken } from "@/lib/api-client";
import { randomId } from "@/lib/utils";
import { isImageFile } from "@/lib/file-support";
import { AttachmentChips } from "./attachment-chips";
import { ModeSelector, getModeLabel, getModeIcon } from "./mode-selector";
import { ProviderSelector } from "./provider-selector";
import { ModelSelector } from "./model-selector";
import type { SlashItem } from "./slash-command-picker";
import type { FileNode } from "../../../types/project";
import { useFileStore } from "@/stores/file-store";

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
  status: "uploading" | "ready" | "error";
}

export type MessagePriority = 'now' | 'next' | 'later';

interface MessageInputProps {
  onSend: (content: string, attachments: ChatAttachment[], priority?: MessagePriority) => void;
  isStreaming?: boolean;
  onCancel?: () => void;
  disabled?: boolean;
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
  /** Bumping this counter clears the textarea (e.g. parent cancels an edit). */
  clearSignal?: number;
  /** Called on content change for draft auto-save */
  onContentChange?: (content: string, attachments?: Array<{ name: string; path: string }>) => void;
  /** Auto-focus textarea on mount */
  autoFocus?: boolean;
  /** Current permission mode */
  permissionMode?: string;
  /** Permission mode change handler */
  onModeChange?: (mode: string) => void;
  /** Current provider ID */
  providerId?: string;
  /** Provider change handler — undefined when session is active (locked) */
  onProviderChange?: (providerId: string) => void;
  /** Current per-session model (null = provider default) */
  model?: string | null;
  /** Model change handler — undefined when no active session */
  onModelChange?: (model: string) => void;
}

export const MessageInput = memo(function MessageInput({
  onSend,
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
  clearSignal,
  onContentChange,
  autoFocus,
  permissionMode,
  onModeChange,
  providerId,
  onProviderChange,
  model,
  onModelChange,
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
  const [priority, setPriority] = useState<MessagePriority>('next');
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

  // Voice input (Web Speech API)
  const voice = useVoiceInput();
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
    if (voice.isListening) {
      voice.stop();
    } else {
      preVoiceTextRef.current = valueRef.current.trim();
      voice.start(voiceResultCb);
    }
  }, [voice.isListening, voice.start, voice.stop, voiceResultCb]);

  // Listen for global keyboard shortcut (Cmd+Shift+V) to toggle voice
  useEffect(() => {
    const handler = () => { if (voice.supported) handleVoiceToggle(); };
    window.addEventListener("toggle-voice-input", handler);
    return () => window.removeEventListener("toggle-voice-input", handler);
  }, [voice.supported, handleVoiceToggle]);

  // Listen for "Send to Chat" from terminal or other tabs — add as attachment chip
  useEffect(() => {
    const handler = (e: Event) => {
      const { text, label } = (e as CustomEvent).detail ?? {};
      if (!text) return;
      window.dispatchEvent(new Event("ppm:send-to-chat:ack"));
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
    window.addEventListener("ppm:send-to-chat", handler);
    return () => window.removeEventListener("ppm:send-to-chat", handler);
  }, [getVisibleTextarea]);

  // Apply initialValue when it changes (e.g. "Ask AI" from command palette)
  useEffect(() => {
    if (initialValue) {
      writeTextareas(initialValue);
      // Focus and move cursor to end
      setTimeout(() => {
        const ta = textareaRef.current;
        if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; }
      }, 50);
    }
  }, [initialValue]); // eslint-disable-line react-hooks/exhaustive-deps

  // Parent-driven clear (e.g. cancelling an edit) — skip initial mount (0).
  useEffect(() => {
    if (clearSignal) writeTextareas("");
  }, [clearSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-focus on mount when requested
  useEffect(() => {
    if (!autoFocus) return;
    setTimeout(() => { getVisibleTextarea()?.focus(); }, 100);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch slash items from server
  const fetchSlashItems = useCallback(() => {
    if (!projectName) {
      slashItemsRef.current = [];
      onSlashItemsLoaded?.([], []);
      return;
    }
    api
      .get<{ items: SlashItem[]; recentNames: string[] }>(`${projectUrl(projectName)}/chat/slash-items`)
      .then((data) => {
        slashItemsRef.current = data.items;
        onSlashItemsLoaded?.(data.items, data.recentNames);
      })
      .catch(() => {
        slashItemsRef.current = [];
        onSlashItemsLoaded?.([], []);
      });
  }, [projectName, onSlashItemsLoaded]);

  // Fetch slash items when projectName changes
  useEffect(() => { fetchSlashItems(); }, [fetchSlashItems]);

  // Re-fetch when cache is invalidated via refresh button
  useEffect(() => {
    const handler = () => fetchSlashItems();
    window.addEventListener("ppm:slash-items-refresh", handler);
    return () => window.removeEventListener("ppm:slash-items-refresh", handler);
  }, [fetchSlashItems]);

  // Sync file picker items from store index — subscribe imperatively to avoid re-renders.
  // Reads fileIndex on mount + whenever fileIndex/indexStatus changes in the store.
  useEffect(() => {
    const syncFromStore = () => {
      if (!projectName) {
        fileItemsRef.current = [];
        onFileItemsLoaded?.([]);
        return;
      }
      const { fileIndex } = useFileStore.getState();
      const nodes: FileNode[] = fileIndex.map((e) => ({ name: e.name, path: e.path, type: e.type }));
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
    // Strip the /query trigger before the cursor, preserving leading whitespace.
    const stripTrigger = (match: string) => (match.startsWith("/") ? "" : match[0]!);

    // Agents render as a removable chip (not inline text) so the composed
    // "Use the X agent to …" prompt is only assembled at send time.
    if (slashSelected.type === "agent") {
      const stripped = textBefore.replace(/(?:^|\s)\/\S*$/, stripTrigger);
      setAgentTag(slashSelected.name);
      writeTextareas(stripped + textAfter);
      onSlashStateChange?.(false, "");
      slashPickerOpenRef.current = false;
      el.focus();
      setTimeout(() => { el.selectionStart = el.selectionEnd = stripped.length; }, 0);
      return;
    }

    // Find the /query pattern before cursor and replace it with the command name
    const replaced = textBefore.replace(/(?:^|\s)\/\S*$/, (match) => {
      const prefix = stripTrigger(match);
      return `${prefix}/${slashSelected.name} `;
    });
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
      for (const file of files) {
        const id = randomId();
        const isImg = isImageFile(file);
        const previewUrl = isImg ? URL.createObjectURL(file) : undefined;

        const att: ChatAttachment = {
          id,
          name: file.name,
          file,
          isImage: isImg,
          previewUrl,
          status: "uploading",
        };

        setAttachments((prev) => [...prev, att]);

        // Upload in background
        uploadFile(file).then((serverPath) => {
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === id
                ? { ...a, serverPath: serverPath ?? undefined, status: serverPath ? "ready" : "error" }
                : a,
            ),
          );
        });
      }
      (mobileTextareaRef.current ?? textareaRef.current)?.focus();
    },
    [uploadFile],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const att = prev.find((a) => a.id === id);
      if (att?.previewUrl) URL.revokeObjectURL(att.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

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
    if (voice.isListening) voice.stop();
    onSend(content, readyAttachments, isStreaming ? priority : undefined);
    writeTextareas("");
    // Revoke preview URLs
    for (const att of attachments) {
      if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
    }
    setAttachments([]);
    setAgentTag(null);
    setPendingSend(false);
    setPriority('next');
    if (needsJsResize.current) {
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      if (mobileTextareaRef.current) mobileTextareaRef.current.style.height = "auto";
    }
  }, [attachments, agentTag, onSend, onSlashStateChange, onFileStateChange, isStreaming, priority, writeTextareas]);

  const handleSend = useCallback(() => {
    if (disabled) return;

    // If files are still uploading, queue the send for when they finish
    if (attachments.some((a) => a.status === "uploading")) {
      const trimmed = valueRef.current.trim();
      if (trimmed || attachments.some((a) => a.status !== "error")) {
        setPendingSend(true);
      }
      return;
    }

    executeSend();
  }, [attachments, disabled, executeSend]);

  // Auto-send when queued and all uploads complete
  useEffect(() => {
    if (!pendingSend) return;
    if (attachments.some((a) => a.status === "uploading")) return;
    executeSend();
  }, [pendingSend, attachments, executeSend]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
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
    [handleSend, permissionMode, onModeChange],
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
        const slashMatch = textBefore.match(/(?:^|\s)\/(\S*)$/);
        if (slashMatch && slashItemsRef.current.length > 0) {
          const filter = slashMatch[1] ?? "";
          onSlashStateChange?.(true, filter);
          slashPickerOpenRef.current = true;
          if (filePickerOpenRef.current) { onFileStateChange?.(false, ""); filePickerOpenRef.current = false; }
          return;
        }
      }

      // Check for @ anywhere in text (after whitespace or at start)
      if (hasAt) {
        const atMatch = textBefore.match(/@(\S*)$/);
        if (atMatch && fileItemsRef.current.length > 0) {
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
    [onSlashStateChange, onFileStateChange],
  );

  /** Unified onChange for both textareas — updates ref, syncs other textarea, triggers picker */
  const handleTextareaChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const el = e.target;
      const text = el.value;
      valueRef.current = text;
      // Sync the other textarea (handles viewport rotation edge case)
      const other = el === textareaRef.current ? mobileTextareaRef.current : textareaRef.current;
      if (other) other.value = text;
      // Only trigger re-render on empty↔non-empty transition (for send button state)
      setHasText(text.trim().length > 0);
      // Update picker state (slash/file autocomplete)
      updatePickerState(text, el.selectionStart);
      // Notify parent for draft auto-save (debounced in hook)
      onContentChange?.(text, attachments.filter((a) => a.status === "ready" && a.serverPath).map((a) => ({ name: a.name, path: a.serverPath! })));
      // JS auto-resize fallback — only when CSS field-sizing: content is unsupported
      if (needsJsResize.current) {
        if (resizeRafRef.current) cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = requestAnimationFrame(() => {
          resizeRafRef.current = 0;
          el.style.height = "auto";
          el.style.height = Math.min(el.scrollHeight, el === mobileTextareaRef.current ? 80 : 160) + "px";
        });
      }
    },
    [updatePickerState, onContentChange, attachments],
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
      }
    },
    [processFiles],
  );

  /** Handle drop directly on textarea */
  const handleDrop = useCallback(
    (e: DragEvent<HTMLTextAreaElement>) => {
      e.preventDefault();
      // Check for internal file tree drag first
      const ppmPath = e.dataTransfer.getData("application/x-ppm-path");
      if (ppmPath) {
        const cur = valueRef.current;
        const sep = cur.length > 0 && !cur.endsWith(" ") ? " " : "";
        writeTextareas(cur + sep + `@${ppmPath} `);
        getVisibleTextarea()?.focus();
        return;
      }
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) processFiles(files);
    },
    [processFiles, writeTextareas, getVisibleTextarea],
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

  return (
    <div className="p-2 md:p-3">
      {/* Rounded input container */}
      <div
        className="border border-border rounded-[var(--rad)] bg-panel shadow-[var(--shadow-float)] cursor-text"
        onClick={(e) => {
          if (disabled) return;
          // Only focus when clicking outside the textarea (e.g. padding area)
          if (e.target instanceof HTMLTextAreaElement) return;
          getVisibleTextarea()?.focus();
        }}
      >
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
        {/* Mobile: mode chip + provider selector row */}
        <div className="flex items-center gap-1 px-2 pt-2 md:hidden relative">
          <ModeChip
            mode={permissionMode ?? "bypassPermissions"}
            onClick={() => setModeSelectorOpen((v) => !v)}
          />
          <ModeSelector
            value={permissionMode ?? "bypassPermissions"}
            onChange={(m) => onModeChange?.(m)}
            open={modeSelectorOpen}
            onOpenChange={setModeSelectorOpen}
          />
          {onProviderChange && projectName && (
            <ProviderSelector
              value={providerId ?? "claude"}
              onChange={onProviderChange}
              projectName={projectName}
            />
          )}
          {onModelChange && projectName && (
            <ModelSelector
              value={model ?? null}
              onChange={onModelChange}
              projectName={projectName}
              providerId={providerId ?? "claude"}
              disabled={isStreaming}
            />
          )}
          {isStreaming && <PriorityToggle value={priority} onChange={setPriority} />}
        </div>
        {/* Mobile: single row — attach + textarea + mic + send */}
        <div className="flex items-end gap-1 md:hidden px-2 py-2">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleAttachClick(); }}
            disabled={disabled}
            className="flex items-center justify-center size-8 shrink-0 rounded-[10px] text-text-3 hover:text-text-primary transition-colors disabled:opacity-50"
            aria-label="Attach file"
          >
            <Paperclip className="size-4" />
          </button>
          <textarea
            ref={mobileTextareaRef}
            defaultValue={initialValue ?? ""}
            onChange={handleTextareaChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            placeholder={isStreaming ? "Follow-up..." : "Ask anything..."}
            disabled={disabled}
            rows={1}
            className="flex-1 resize-none bg-transparent py-1.5 text-sm text-foreground placeholder:text-text-subtle focus:outline-none disabled:opacity-50 max-h-20 [field-sizing:content]"
          />
          {voice.supported && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); handleVoiceToggle(); }}
              disabled={disabled}
              className={`flex items-center justify-center size-8 shrink-0 rounded-[10px] transition-colors disabled:opacity-50 ${
                voice.isListening
                  ? "bg-error text-white animate-pulse"
                  : "text-text-3 hover:text-text-primary"
              }`}
              aria-label={voice.isListening ? "Stop voice input" : "Start voice input"}
            >
              {voice.isListening ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            </button>
          )}
          {showCancel ? (
            <button
              onClick={(e) => { e.stopPropagation(); onCancel?.(); }}
              className="flex items-center justify-center size-9 shrink-0 rounded-[11px] bg-error text-white hover:bg-error/80 shadow-[var(--shadow-float)] transition-colors"
              aria-label="Stop"
            >
              <Square className="size-3.5" />
            </button>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); pendingSend ? setPendingSend(false) : handleSend(); }}
              disabled={disabled || !hasContent}
              className="flex items-center justify-center size-9 shrink-0 rounded-[11px] bg-primary text-primary-foreground hover:bg-primary/90 shadow-[var(--shadow-float)] disabled:opacity-30 disabled:shadow-none transition-colors"
              aria-label={pendingSend ? "Cancel queued send" : "Send"}
            >
              {pendingSend ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
            </button>
          )}
        </div>

        {/* Desktop: chips row (permission + model) then a single input row
            (paperclip | textarea | mic | send) — design PPMWorkspace composer. */}
        <div className="hidden md:block">
          <div className="flex items-center gap-1.5 px-2.5 pt-2.5">
            {/* Mode indicator chip */}
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
              />
            </div>
            {/* Provider selector — only when no active session */}
            {onProviderChange && projectName && (
              <ProviderSelector
                value={providerId ?? "claude"}
                onChange={onProviderChange}
                projectName={projectName}
              />
            )}
            {onModelChange && projectName && (
              <ModelSelector
                value={model ?? null}
                onChange={onModelChange}
                projectName={projectName}
                providerId={providerId ?? "claude"}
                disabled={isStreaming}
              />
            )}
            {isStreaming && <PriorityToggle value={priority} onChange={setPriority} />}
          </div>
          <div className="flex items-end gap-2 px-2.5 py-2">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); handleAttachClick(); }}
              disabled={disabled}
              className="flex items-center justify-center size-[34px] shrink-0 rounded-[10px] text-text-3 hover:text-text-primary hover:bg-surface-elevated transition-colors disabled:opacity-50"
              aria-label="Attach file"
            >
              <Paperclip className="size-[17px]" />
            </button>
            <textarea
              ref={textareaRef}
              defaultValue={initialValue ?? ""}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              placeholder={isStreaming ? "Follow-up or Stop..." : "Ask anything..."}
              disabled={disabled}
              rows={1}
              className="flex-1 resize-none bg-transparent py-2 text-sm text-foreground placeholder:text-text-subtle focus:outline-none disabled:opacity-50 max-h-[90px] leading-relaxed [field-sizing:content]"
            />
            {voice.supported && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); handleVoiceToggle(); }}
                disabled={disabled}
                className={`flex items-center justify-center size-[34px] shrink-0 rounded-[10px] transition-colors disabled:opacity-50 ${
                  voice.isListening
                    ? "bg-error text-white animate-pulse"
                    : "text-text-3 hover:text-text-primary hover:bg-surface-elevated"
                }`}
                aria-label={voice.isListening ? "Stop voice input" : "Start voice input"}
              >
                {voice.isListening ? <MicOff className="size-[17px]" /> : <Mic className="size-[17px]" />}
              </button>
            )}
            {showCancel ? (
              <button
                onClick={(e) => { e.stopPropagation(); onCancel?.(); }}
                className="flex items-center justify-center size-9 shrink-0 rounded-[11px] bg-error text-white hover:bg-error/80 shadow-[var(--shadow-float)] transition-colors"
                aria-label="Stop response"
              >
                <Square className="size-4" />
              </button>
            ) : (
              <button
                onClick={(e) => { e.stopPropagation(); pendingSend ? setPendingSend(false) : handleSend(); }}
                disabled={disabled || !hasContent}
                className="flex items-center justify-center size-9 shrink-0 rounded-[11px] bg-primary text-primary-foreground hover:bg-primary/90 shadow-[var(--shadow-float)] disabled:opacity-30 disabled:cursor-not-allowed disabled:shadow-none transition-colors"
                aria-label={pendingSend ? "Cancel queued send" : "Send message"}
              >
                {pendingSend ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-[17px]" />}
              </button>
            )}
          </div>
        </div>
      </div>

      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileInputChange} />
    </div>
  );
});

/** Small chip showing current permission mode */
function ModeChip({ mode, onClick }: { mode: string; onClick: () => void }) {
  const Icon = getModeIcon(mode);
  const label = getModeLabel(mode);
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="inline-flex items-center gap-1.5 px-[9px] py-1 rounded-full text-[11.5px] text-text-2 bg-panel-2 border border-border-soft hover:text-text-primary hover:border-border transition-colors"
      aria-label={`Permission mode: ${label}`}
    >
      <Icon className="size-3" />
      <span className="max-w-[100px] truncate">{label}</span>
    </button>
  );
}

const PRIORITY_OPTIONS: { value: MessagePriority; label: string; Icon: typeof Zap }[] = [
  { value: 'now', label: 'Interrupt', Icon: Zap },
  { value: 'next', label: 'Queue', Icon: ListOrdered },
  { value: 'later', label: 'Later', Icon: Clock },
];

/** Compact priority toggle — visible only during streaming */
function PriorityToggle({ value, onChange }: { value: MessagePriority; onChange: (v: MessagePriority) => void }) {
  const cycle = useCallback(() => {
    const order: MessagePriority[] = ['next', 'later', 'now'];
    const idx = order.indexOf(value);
    onChange(order[(idx + 1) % order.length]!);
  }, [value, onChange]);

  const current = PRIORITY_OPTIONS.find((o) => o.value === value) ?? PRIORITY_OPTIONS[1]!;
  const Icon = current.Icon;

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); cycle(); }}
      className="inline-flex items-center gap-1.5 px-[9px] py-1 rounded-full text-[11.5px] text-text-2 bg-panel-2 border border-border-soft hover:text-text-primary hover:border-border transition-colors"
      aria-label={`Message priority: ${current.label}`}
      title={`Priority: ${current.label} (click to cycle)`}
    >
      <Icon className="size-3" />
      <span>{current.label}</span>
    </button>
  );
}
