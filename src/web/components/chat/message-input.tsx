import { useState, useRef, useCallback, useEffect, type KeyboardEvent } from "react";
import { Send, Square } from "lucide-react";
import { api, projectUrl } from "@/lib/api-client";
import type { SlashItem } from "./slash-command-picker";
import type { FileNode } from "../../../types/project";
import { flattenFileTree } from "./file-picker";

interface MessageInputProps {
  onSend: (content: string) => void;
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
}: MessageInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
    const commandText = `/${slashSelected.name} `;
    setValue(commandText);
    onSlashStateChange?.(false, "");
    onFileStateChange?.(false, "");
    const el = textareaRef.current;
    if (el) {
      el.focus();
      setTimeout(() => {
        el.selectionStart = el.selectionEnd = commandText.length;
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

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSlashStateChange?.(false, "");
    onFileStateChange?.(false, "");
    onSend(trimmed);
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [value, disabled, onSend, onSlashStateChange, onFileStateChange]);

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
      // Check for slash at start of input
      const slashMatch = text.match(/^\/(\S*)$/);
      if (slashMatch && slashItemsRef.current.length > 0) {
        onSlashStateChange?.(true, slashMatch[1] ?? "");
        onFileStateChange?.(false, "");
        return;
      }

      // Check for @ anywhere in text (look at text before cursor)
      const textBefore = text.slice(0, cursorPos);
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

  const hasText = value.trim().length > 0;
  const showCancel = isStreaming && !hasText;

  return (
    <div className="flex items-end gap-2 p-3 border-t border-border bg-background">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => {
          handleChange(e.target.value);
          handleInput();
        }}
        onKeyDown={handleKeyDown}
        placeholder={isStreaming ? "Send follow-up or press Stop..." : "Type / for commands, @ for files..."}
        disabled={disabled}
        rows={1}
        className="flex-1 resize-none rounded-lg border border-border bg-surface px-3 py-2 text-base md:text-sm text-text-primary placeholder:text-text-subtle focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 max-h-40"
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
          disabled={disabled || !hasText}
          className="flex items-center justify-center rounded-lg bg-primary p-2 text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
          aria-label="Send message"
        >
          <Send className="size-4" />
        </button>
      )}
    </div>
  );
}
