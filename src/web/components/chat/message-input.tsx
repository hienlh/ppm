import { useState, useRef, useCallback, useEffect, memo, type KeyboardEvent, type DragEvent, type ClipboardEvent } from "react";
import { ArrowUp, Square, Paperclip, Loader2, Mic, MicOff, Zap, ListOrdered, Clock } from "lucide-react";
import { useVoiceInput } from "@/hooks/use-voice-input";
import { api, projectUrl, getAuthToken } from "@/lib/api-client";
import { randomId } from "@/lib/utils";
import { isSupportedFile, isImageFile } from "@/lib/file-support";
import { AttachmentChips } from "./attachment-chips";
import { ModeSelector, getModeLabel, getModeIcon } from "./mode-selector";
import { ProviderSelector } from "./provider-selector";
import type { SlashItem } from "./slash-command-picker";
import type { FileNode } from "../../../types/project";
import { flattenFileTree } from "./file-picker";

export interface ChatAttachment {
  id: string;
  name: string;
  file: File;
  isImage: boolean;
  previewUrl?: string;
  /** Server-side path after upload */
  serverPath?: string;
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
  onSlashItemsLoaded?: (items: SlashItem[]) => void;
  slashSelected?: SlashItem | null;
  /** File picker state change */
  onFileStateChange?: (visible: boolean, filter: string) => void;
  onFileItemsLoaded?: (items: FileNode[]) => void;
  fileSelected?: FileNode | null;
  /** External files added via drag-drop on parent */
  externalFiles?: File[] | null;
  /** Pre-fill input value (e.g. from command palette "Ask AI") */
  initialValue?: string;
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
  initialValue,
  autoFocus,
  permissionMode,
  onModeChange,
  providerId,
  onProviderChange,
}: MessageInputProps) {
  const [value, setValue] = useState(initialValue ?? "");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [modeSelectorOpen, setModeSelectorOpen] = useState(false);
  const [pendingSend, setPendingSend] = useState(false);
  const [priority, setPriority] = useState<MessagePriority>('next');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mobileTextareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const slashItemsRef = useRef<SlashItem[]>([]);
  const fileItemsRef = useRef<FileNode[]>([]);

  // Voice input (Web Speech API)
  const voice = useVoiceInput();
  // Store pre-voice text so voice appends to existing input
  const preVoiceTextRef = useRef("");
  const voiceResultCb = useCallback((text: string) => {
    const prefix = preVoiceTextRef.current;
    const newValue = prefix ? prefix + " " + text : text;
    setValue(newValue);
    // Auto-resize textarea
    requestAnimationFrame(() => {
      const ta = window.matchMedia("(min-width: 768px)").matches
        ? textareaRef.current
        : mobileTextareaRef.current;
      if (ta) {
        ta.style.height = "auto";
        ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
      }
    });
  }, []);
  const handleVoiceToggle = useCallback(() => {
    if (voice.isListening) {
      voice.stop();
    } else {
      preVoiceTextRef.current = value.trim();
      voice.start(voiceResultCb);
    }
  }, [voice.isListening, voice.start, voice.stop, value, voiceResultCb]);

  // Listen for global keyboard shortcut (Cmd+Shift+V) to toggle voice
  useEffect(() => {
    const handler = () => { if (voice.supported) handleVoiceToggle(); };
    window.addEventListener("toggle-voice-input", handler);
    return () => window.removeEventListener("toggle-voice-input", handler);
  }, [voice.supported, handleVoiceToggle]);

  // Apply initialValue when it changes (e.g. "Ask AI" from command palette)
  useEffect(() => {
    if (initialValue) {
      setValue(initialValue);
      // Focus and move cursor to end
      setTimeout(() => {
        const ta = textareaRef.current;
        if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; }
      }, 50);
    }
  }, [initialValue]);

  // Auto-focus on mount when requested
  useEffect(() => {
    if (!autoFocus) return;
    setTimeout(() => {
      const ta = window.matchMedia("(min-width: 768px)").matches
        ? textareaRef.current
        : mobileTextareaRef.current;
      ta?.focus();
    }, 100);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch slash items when projectName changes
  useEffect(() => {
    if (!projectName) {
      slashItemsRef.current = [];
      onSlashItemsLoaded?.([]);
      return;
    }
    api
      .get<SlashItem[]>(`${projectUrl(projectName)}/chat/slash-items`)
      .then((items) => {
        slashItemsRef.current = items;
        onSlashItemsLoaded?.(items);
      })
      .catch(() => {
        slashItemsRef.current = [];
        onSlashItemsLoaded?.([]);
      });
  }, [projectName]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch file tree when projectName changes
  useEffect(() => {
    if (!projectName) {
      fileItemsRef.current = [];
      onFileItemsLoaded?.([]);
      return;
    }
    api
      .get<FileNode[]>(`${projectUrl(projectName)}/files/tree?depth=5`)
      .then((tree) => {
        const flat = flattenFileTree(tree);
        fileItemsRef.current = flat;
        onFileItemsLoaded?.(flat);
      })
      .catch(() => {
        fileItemsRef.current = [];
        onFileItemsLoaded?.([]);
      });
  }, [projectName]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle parent selecting a slash item
  useEffect(() => {
    if (!slashSelected) return;
    const el = textareaRef.current;
    const cursorPos = el?.selectionStart ?? value.length;
    const textBefore = value.slice(0, cursorPos);
    const textAfter = value.slice(cursorPos);
    // Find the /query pattern before cursor and replace it
    const replaced = textBefore.replace(/(?:^|\s)\/\S*$/, (match) => {
      const prefix = match.startsWith("/") ? "" : match[0]; // preserve whitespace
      return `${prefix}/${slashSelected.name} `;
    });
    const newValue = replaced + textAfter;
    setValue(newValue);
    onSlashStateChange?.(false, "");
    onFileStateChange?.(false, "");
    if (el) {
      el.focus();
      setTimeout(() => {
        el.selectionStart = el.selectionEnd = replaced.length;
      }, 0);
    }
  }, [slashSelected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle parent selecting a file
  useEffect(() => {
    if (!fileSelected) return;
    const el = textareaRef.current;
    if (!el) return;

    // Replace the @query with @path
    const cursorPos = el.selectionStart;
    const textBefore = value.slice(0, cursorPos);
    const textAfter = value.slice(cursorPos);
    // Find the @ trigger before cursor
    const atMatch = textBefore.match(/@(\S*)$/);
    if (atMatch) {
      const start = textBefore.length - atMatch[0].length;
      const newText = textBefore.slice(0, start) + `@${fileSelected.path} ` + textAfter;
      setValue(newText);
      const newCursorPos = start + fileSelected.path.length + 2; // +2 for @ and space
      setTimeout(() => {
        el.selectionStart = el.selectionEnd = newCursorPos;
        el.focus();
      }, 0);
    } else {
      // Fallback: append at end
      const newText = value + `@${fileSelected.path} `;
      setValue(newText);
      setTimeout(() => {
        el.selectionStart = el.selectionEnd = newText.length;
        el.focus();
      }, 0);
    }
    onFileStateChange?.(false, "");
  }, [fileSelected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle external files dropped on parent (ChatTab)
  useEffect(() => {
    if (!externalFiles || externalFiles.length === 0) return;
    processFiles(externalFiles);
  }, [externalFiles]); // eslint-disable-line react-hooks/exhaustive-deps

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

  /** Process dropped/pasted/selected files */
  const processFiles = useCallback(
    (files: File[]) => {
      for (const file of files) {
        if (!isSupportedFile(file)) {
          // Unsupported → insert file name as text
          setValue((prev) => prev + (prev.length > 0 && !prev.endsWith(" ") ? " " : "") + file.name);
          continue;
        }

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
    const trimmed = value.trim();
    const readyAttachments = attachments.filter((a) => a.status === "ready");
    if (!trimmed && readyAttachments.length === 0) {
      setPendingSend(false);
      return;
    }

    onSlashStateChange?.(false, "");
    onFileStateChange?.(false, "");
    if (voice.isListening) voice.stop();
    onSend(trimmed, readyAttachments, isStreaming ? priority : undefined);
    setValue("");
    // Revoke preview URLs
    for (const att of attachments) {
      if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
    }
    setAttachments([]);
    setPendingSend(false);
    setPriority('next');
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    if (mobileTextareaRef.current) mobileTextareaRef.current.style.height = "auto";
  }, [value, attachments, onSend, onSlashStateChange, onFileStateChange, isStreaming, priority]);

  const handleSend = useCallback(() => {
    if (disabled) return;

    // If files are still uploading, queue the send for when they finish
    if (attachments.some((a) => a.status === "uploading")) {
      const trimmed = value.trim();
      if (trimmed || attachments.some((a) => a.status !== "error")) {
        setPendingSend(true);
      }
      return;
    }

    executeSend();
  }, [value, attachments, disabled, executeSend]);

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

      // Check for slash anywhere in text (after whitespace or at start)
      const slashMatch = textBefore.match(/(?:^|\s)\/(\S*)$/);
      if (slashMatch && slashItemsRef.current.length > 0) {
        onSlashStateChange?.(true, slashMatch[1] ?? "");
        onFileStateChange?.(false, "");
        return;
      }

      // Check for @ anywhere in text (after whitespace or at start)
      const atMatch = textBefore.match(/@(\S*)$/);
      if (atMatch && fileItemsRef.current.length > 0) {
        onFileStateChange?.(true, atMatch[1] ?? "");
        onSlashStateChange?.(false, "");
        return;
      }

      // Nothing matched — close both pickers
      onSlashStateChange?.(false, "");
      onFileStateChange?.(false, "");
    },
    [onSlashStateChange, onFileStateChange],
  );

  const handleChange = useCallback(
    (text: string, cursorPos: number) => {
      setValue(text);
      updatePickerState(text, cursorPos);
    },
    [updatePickerState],
  );

  const handleInput = useCallback((e?: React.ChangeEvent<HTMLTextAreaElement>) => {
    const el = e?.target ?? textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, []);

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
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) processFiles(files);
    },
    [processFiles],
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

  const hasContent = value.trim().length > 0 || attachments.some((a) => a.status !== "error");
  const showCancel = isStreaming && !hasContent;

  return (
    <div className="p-2 md:p-3 bg-background">
      {/* Rounded input container */}
      <div
        className="border border-border rounded-xl md:rounded-2xl bg-surface shadow-sm cursor-text"
        onClick={(e) => {
          if (disabled) return;
          // Only focus when clicking outside the textarea (e.g. padding area)
          if (e.target instanceof HTMLTextAreaElement) return;
          // Pick the visible textarea based on viewport width
          const ta = window.matchMedia("(min-width: 768px)").matches
            ? textareaRef.current
            : mobileTextareaRef.current;
          ta?.focus();
        }}
      >
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
          {isStreaming && <PriorityToggle value={priority} onChange={setPriority} />}
        </div>
        {/* Mobile: single row — attach + mic + textarea + send */}
        <div className="flex items-end gap-1 md:hidden px-2 py-2">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleAttachClick(); }}
            disabled={disabled}
            className="flex items-center justify-center size-7 shrink-0 rounded-full text-text-subtle hover:text-text-primary transition-colors disabled:opacity-50"
            aria-label="Attach file"
          >
            <Paperclip className="size-4" />
          </button>
          {voice.supported && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); handleVoiceToggle(); }}
              disabled={disabled}
              className={`flex items-center justify-center size-7 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
                voice.isListening
                  ? "bg-red-600 text-white animate-pulse"
                  : "text-text-subtle hover:text-text-primary"
              }`}
              aria-label={voice.isListening ? "Stop voice input" : "Start voice input"}
            >
              {voice.isListening ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            </button>
          )}
          <textarea
            ref={mobileTextareaRef}
            value={value}
            onChange={(e) => { handleChange(e.target.value, e.target.selectionStart); handleInput(e); }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            placeholder={isStreaming ? "Follow-up..." : "Ask anything..."}
            disabled={disabled}
            rows={1}
            className="flex-1 resize-none bg-transparent py-1.5 text-sm text-foreground placeholder:text-text-subtle focus:outline-none disabled:opacity-50 max-h-20"
          />
          {showCancel ? (
            <button
              onClick={(e) => { e.stopPropagation(); onCancel?.(); }}
              className="flex items-center justify-center size-7 shrink-0 rounded-full bg-red-600 text-white hover:bg-red-500 transition-colors"
              aria-label="Stop"
            >
              <Square className="size-3" />
            </button>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); pendingSend ? setPendingSend(false) : handleSend(); }}
              disabled={disabled || !hasContent}
              className="flex items-center justify-center size-7 shrink-0 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-30 transition-colors"
              aria-label={pendingSend ? "Cancel queued send" : "Send"}
            >
              {pendingSend ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowUp className="size-3.5" />}
            </button>
          )}
        </div>

        {/* Desktop: textarea + action bar below */}
        <div className="hidden md:block">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => { handleChange(e.target.value, e.target.selectionStart); handleInput(e); }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            placeholder={isStreaming ? "Follow-up or Stop..." : "Ask anything..."}
            disabled={disabled}
            rows={1}
            className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm text-foreground placeholder:text-text-subtle focus:outline-none disabled:opacity-50 max-h-40"
          />
          <div className="flex items-center justify-between px-3 pb-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); handleAttachClick(); }}
                disabled={disabled}
                className="flex items-center justify-center size-8 rounded-full text-text-subtle hover:text-text-primary hover:bg-surface-elevated transition-colors disabled:opacity-50"
                aria-label="Attach file"
              >
                <Paperclip className="size-4" />
              </button>
              {voice.supported && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleVoiceToggle(); }}
                  disabled={disabled}
                  className={`flex items-center justify-center size-8 rounded-full transition-colors disabled:opacity-50 ${
                    voice.isListening
                      ? "bg-red-600 text-white animate-pulse"
                      : "text-text-subtle hover:text-text-primary hover:bg-surface-elevated"
                  }`}
                  aria-label={voice.isListening ? "Stop voice input" : "Start voice input"}
                >
                  {voice.isListening ? <MicOff className="size-4" /> : <Mic className="size-4" />}
                </button>
              )}
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
              {isStreaming && <PriorityToggle value={priority} onChange={setPriority} />}
            </div>
            <div className="flex items-center gap-1">
              {showCancel ? (
                <button
                  onClick={(e) => { e.stopPropagation(); onCancel?.(); }}
                  className="flex items-center justify-center size-8 rounded-full bg-red-600 text-white hover:bg-red-500 transition-colors"
                  aria-label="Stop response"
                >
                  <Square className="size-3.5" />
                </button>
              ) : (
                <button
                  onClick={(e) => { e.stopPropagation(); pendingSend ? setPendingSend(false) : handleSend(); }}
                  disabled={disabled || !hasContent}
                  className="flex items-center justify-center size-8 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  aria-label={pendingSend ? "Cancel queued send" : "Send message"}
                >
                  {pendingSend ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
                </button>
              )}
            </div>
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
      className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-text-subtle hover:text-text-primary hover:bg-surface-elevated transition-colors border border-transparent hover:border-border"
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
      className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-text-subtle hover:text-text-primary hover:bg-surface-elevated transition-colors border border-transparent hover:border-border"
      aria-label={`Message priority: ${current.label}`}
      title={`Priority: ${current.label} (click to cycle)`}
    >
      <Icon className="size-3" />
      <span>{current.label}</span>
    </button>
  );
}
