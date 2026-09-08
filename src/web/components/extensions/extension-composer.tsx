import { useState, useEffect, useCallback, type KeyboardEvent } from "react";
import { X } from "@/lib/icons";
import { useExtensionStore } from "@/stores/extension-store";
import { useProjectStore } from "@/stores/project-store";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { MessageInput, type ChatAttachment } from "@/components/chat/message-input";
import { SlashCommandPicker } from "@/components/chat/slash-command-picker";
import { FilePicker } from "@/components/chat/file-picker";
import { buildMessageWithAttachments } from "@/components/chat/build-message-with-attachments";
import { useExtensionComposerPickers } from "./extension-composer-pickers";

/**
 * Extension-driven composer dialog: an extension called `window.showComposer()` and is
 * waiting for the user's next chat message. Renders the SAME MessageInput a chat tab uses
 * (slash/file pickers, model+thinking selector, permission mode) so the extension gets the
 * real chat input, not a stripped-down copy.
 *
 * Always authors against the currently active project — `ComposerOptions` carries no
 * `projectName` because MessageInput's own `@` file picker reads the active project's file
 * index regardless of what a caller passes in (see message-input.tsx's file-store sync).
 */
export function ExtensionComposer() {
  const composer = useExtensionStore((s) => s.composer);
  const resolveComposer = useExtensionStore((s) => s.resolveComposer);
  const activeProject = useProjectStore((s) => s.activeProject);
  const isMobile = useIsMobile();
  const projectName = activeProject?.name ?? "";
  const pickers = useExtensionComposerPickers(projectName);

  const [permissionMode, setPermissionMode] = useState("bypassPermissions");
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);

  // Re-seed local selector state from options each time a NEW request opens — a stale
  // selection from a previous prompt must not leak into the next one.
  useEffect(() => {
    if (!composer) return;
    setPermissionMode(composer.options.permissionMode ?? "bypassPermissions");
    setModel(composer.options.model ?? null);
    setEffort(null);
    setThinking(false);
  }, [composer?.requestId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCancel = useCallback(() => {
    if (composer) resolveComposer(composer.requestId, undefined);
  }, [composer, resolveComposer]);

  const handleSend = useCallback(
    (content: string, attachments: ChatAttachment[]) => {
      if (!composer) return;
      const fullContent = buildMessageWithAttachments(content, attachments);
      if (!fullContent.trim()) return;
      resolveComposer(composer.requestId, {
        content: fullContent,
        model: model ?? undefined,
        effort: effort ?? undefined,
        thinking,
        permissionMode,
      });
    },
    [composer, resolveComposer, model, effort, thinking, permissionMode],
  );

  // The dialog floats outside the tab pool, so `ownsGlobalShortcut` treats it as owning
  // window-level shortcuts purely by visibility (owns-global-shortcut.ts:18) — without
  // stopping propagation here, the same keypress would ALSO reach whichever chat tab is
  // focused underneath, double-handling it (voice toggle, send-to-chat, etc.).
  const handleKeyDownCapture = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      e.stopPropagation();
      if (e.key === "Escape") handleCancel();
    },
    [handleCancel],
  );

  if (!composer) return null;

  const body = (
    <div className="flex flex-col" onKeyDownCapture={handleKeyDownCapture}>
      <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-1">
        <span className="text-sm font-medium text-text-primary truncate">
          {composer.options.title ?? "Compose message"}
        </span>
        <button
          type="button"
          onClick={handleCancel}
          className="flex items-center justify-center size-11 shrink-0 rounded hover:bg-accent text-text-secondary hover:text-text-primary transition-colors"
          aria-label="Cancel"
        >
          <X className="size-4" />
        </button>
      </div>
      {composer.options.prompt && (
        <div className="px-3 pb-2 text-sm text-text-secondary">{composer.options.prompt}</div>
      )}
      <SlashCommandPicker
        items={pickers.slashItems}
        filter={pickers.slashFilter}
        onSelect={pickers.handleSlashSelect}
        onClose={pickers.handleSlashClose}
        visible={pickers.showSlashPicker}
        recentNames={pickers.slashRecentNames}
        projectName={projectName}
      />
      <FilePicker
        items={pickers.fileItems}
        filter={pickers.fileFilter}
        onSelect={pickers.handleFileSelect}
        onClose={pickers.handleFileClose}
        visible={pickers.showFilePicker}
      />
      <MessageInput
        onSend={handleSend}
        autoFocus
        initialValue={composer.options.value}
        projectName={projectName}
        onSlashStateChange={pickers.handleSlashStateChange}
        onSlashItemsLoaded={pickers.handleSlashItemsLoaded}
        slashSelected={pickers.slashSelected}
        onFileStateChange={pickers.handleFileStateChange}
        onFileItemsLoaded={pickers.setFileItems}
        fileSelected={pickers.fileSelected}
        permissionMode={permissionMode}
        onModeChange={setPermissionMode}
        model={model}
        onModelChange={setModel}
        effort={effort}
        onEffortChange={setEffort}
        thinking={thinking}
        onThinkingChange={setThinking}
      />
    </div>
  );

  if (isMobile) {
    return (
      <BottomSheet open onClose={handleCancel}>
        {body}
      </BottomSheet>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={handleCancel}
    >
      <div className="fixed inset-0 bg-black/50" />
      <div
        className="relative z-10 w-full max-w-xl rounded-xl border border-border bg-background shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {body}
      </div>
    </div>
  );
}
