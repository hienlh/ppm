import { useState, useRef, useCallback, useEffect, type KeyboardEvent, type DragEvent, type ClipboardEvent } from "react";
import { Send, Square, Paperclip } from "lucide-react";
import { api, projectUrl, getAuthToken } from "@/lib/api-client";
import { randomId } from "@/lib/utils";
import { isSupportedFile, isImageFile } from "@/lib/file-support";
import { AttachmentChips } from "./attachment-chips";
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

interface MessageInputProps {
  onSend: (content: string, attachments: ChatAttachment[]) => void;
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
}

export function MessageInput({
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
}: MessageInputProps) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const slashItemsRef = useRef<SlashItem[]>([]);
  const fileItemsRef = useRef<FileNode[]>([]);

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
      textareaRef.current?.focus();
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

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    const readyAttachments = attachments.filter((a) => a.status === "ready");
    if (!trimmed && readyAttachments.length === 0) return;
    if (disabled) return;

    onSlashStateChange?.(false, "");
    onFileStateChange?.(false, "");
    onSend(trimmed, readyAttachments);
    setValue("");
    // Revoke preview URLs
    for (const att of attachments) {
      if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
    }
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [value, attachments, disabled, onSend, onSlashStateChange, onFileStateChange]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
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
    (text: string) => {
      setValue(text);
      // Use setTimeout to read cursor position after React processes the change
      setTimeout(() => {
        const cursorPos = textareaRef.current?.selectionStart ?? text.length;
        updatePickerState(text, cursorPos);
      }, 0);
    },
    [updatePickerState],
  );

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
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

  const hasContent = value.trim().length > 0 || attachments.some((a) => a.status === "ready");
  const showCancel = isStreaming && !hasContent;

  return (
    <div className="border-t border-border bg-background">
      {/* Attachment chips */}
      <AttachmentChips attachments={attachments} onRemove={removeAttachment} />

      {/* Input row */}
      <div className="flex items-end gap-2 p-3">
        {/* Attach button */}
        <button
          type="button"
          onClick={handleAttachClick}
          disabled={disabled}
          className="flex items-center justify-center rounded-lg p-2 text-text-subtle hover:text-text-primary hover:bg-surface transition-colors shrink-0 disabled:opacity-50"
          aria-label="Attach file"
        >
          <Paperclip className="size-4" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileInputChange}
        />

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            handleChange(e.target.value);
            handleInput();
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          placeholder={isStreaming ? "Follow-up or Stop..." : "Message... (↵ to send)"}
          disabled={disabled}
          rows={1}
          className="flex-1 resize-none rounded-lg border border-border bg-surface px-3 py-2 text-base md:text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring disabled:opacity-50 max-h-40"
        />
        {showCancel ? (
          <button
            onClick={onCancel}
            className="flex items-center justify-center rounded-lg bg-red-600 p-2 text-white hover:bg-red-500 transition-colors shrink-0"
            aria-label="Stop response"
          >
            <Square className="size-4" />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={disabled || !hasContent}
            className="flex items-center justify-center rounded-lg bg-primary p-2 text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
            aria-label="Send message"
          >
            <Send className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}
