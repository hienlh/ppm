/**
 * Binds the action modules to one window's slice and owns the state of its interruptions:
 * the collision prompt (`use-collision-prompt.ts`), the permanent-delete confirmation and the
 * properties dialog. Prompts are modelled as promises resolved by the dialog, so the action
 * modules stay plain async functions with no React inside them.
 */

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { FsEntry } from "@/lib/fs-api";
import { openTerminalAt } from "@/lib/open-terminal-at";
import { useExplorerPinsStore } from "../explorer-pins-store";
import { useExplorerStore, type ExplorerSlice } from "../explorer-store";
import type { ExplorerNavigation } from "../use-explorer-navigation";
import { copyTextLines, downloadEntries, openEntryInPpm, openPathInNewWindow } from "./explorer-actions-open";
import { pasteInto, setClipboardPaths, transfer } from "./explorer-actions-clipboard";
import { createEntry, deleteEntries, renameEntry, validateEntryName } from "./explorer-actions-mutate";
import { useExplorerUploadActions } from "./use-explorer-upload-actions";
import { useCollisionPrompt, type CollisionPromptState } from "./use-collision-prompt";
import { usePermanentOverwritePrompt, type PermanentOverwritePromptState } from "./use-permanent-overwrite-prompt";
import type { DroppedEntry } from "../upload/collect-dropped-entries";

export interface ExplorerActions {
  openEntry(entry: FsEntry): void;
  openInNewWindow(entry: FsEntry): void;
  /** Shell in the dock starting in the given directory (or the file's parent). */
  openInTerminal(entry?: FsEntry): void;
  cut(entries: FsEntry[]): void;
  copy(entries: FsEntry[]): void;
  paste(targetDir?: string): void;
  startRename(entry: FsEntry): void;
  startCreate(kind: "new-file" | "new-folder"): void;
  commitInline(value: string): Promise<void>;
  cancelInline(): void;
  trash(entries: FsEntry[]): void;
  confirmPermanentDelete(entries: FsEntry[]): void;
  download(entries: FsEntry[]): void;
  copyPath(paths: string[]): void;
  copyName(names: string[]): void;
  togglePin(path: string, name: string): void;
  showProperties(entry: FsEntry): void;
  /** Move or copy arbitrary paths into a directory — also the drag-and-drop entry point. */
  transferInto(paths: string[], dstDir: string, op: "copy" | "move"): Promise<void>;
  /** Upload dropped/picked OS files into a directory — the upload counterpart of `transferInto`. */
  uploadInto(entries: DroppedEntry[], dstDir: string): Promise<void>;
  openUploadPicker(): void;
  openUploadFolderPicker(): void;
  supportsFolderUpload: boolean;
}

export interface ExplorerDialogState {
  collision: CollisionPromptState | null;
  pendingDelete: { paths: string[]; names: string[] } | null;
  /** "Replace" hit a host with no trash backend — confirm a permanent overwrite instead. */
  permanentOverwrite: PermanentOverwritePromptState | null;
  properties: FsEntry | null;
  inlineError: string | null;
  closeDelete(): void;
  runPermanentDelete(): void;
  closeProperties(): void;
  /** Hidden upload `<input>`s — render once per window. */
  uploadInputs: ReactNode;
}

export function useExplorerActions(
  windowId: string,
  slice: ExplorerSlice | undefined,
  nav: ExplorerNavigation,
  platform: string | undefined,
): { actions: ExplorerActions; dialogs: ExplorerDialogState } {
  const patch = useExplorerStore((s) => s.patch);
  const collisionPrompt = useCollisionPrompt();
  const permanentOverwritePrompt = usePermanentOverwritePrompt();
  const [pendingDelete, setPendingDelete] = useState<ExplorerDialogState["pendingDelete"]>(null);
  const [properties, setProperties] = useState<FsEntry | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);

  const sliceRef = useRef(slice);
  sliceRef.current = slice;

  // Read through refs so `context` keeps a stable identity ([]-deps) even though both
  // prompts' own functions change identity on every queued/resolved request.
  const collisionPromptRef = useRef(collisionPrompt);
  collisionPromptRef.current = collisionPrompt;
  const permanentOverwritePromptRef = useRef(permanentOverwritePrompt);
  permanentOverwritePromptRef.current = permanentOverwritePrompt;

  const context = useMemo(() => ({
    get sep() {
      return sliceRef.current?.sep ?? "/";
    },
    resolve: (request: Parameters<typeof collisionPrompt.resolve>[0]) => collisionPromptRef.current.resolve(request),
    startBatch: () => collisionPromptRef.current.startBatch(),
    endBatch: () => collisionPromptRef.current.endBatch(),
    confirmPermanentOverwrite: (name: string) => permanentOverwritePromptRef.current.confirm(name),
  }), []);

  const currentDir = () => sliceRef.current?.path ?? "";
  const upload = useExplorerUploadActions(context, currentDir);

  const actions = useMemo<ExplorerActions>(() => ({
    openEntry: (entry) => {
      if (entry.type === "directory") nav.go(entry.path);
      else openEntryInPpm(entry);
    },
    openInNewWindow: (entry) => {
      openPathInNewWindow(entry.type === "directory" ? entry.path : (sliceRef.current?.path ?? entry.path));
    },
    openInTerminal: (entry) => {
      openTerminalAt(entry?.type === "directory" ? entry.path : currentDir());
    },
    cut: (entries) => setClipboardPaths(entries.map((e) => e.path), "cut"),
    copy: (entries) => setClipboardPaths(entries.map((e) => e.path), "copy"),
    paste: (targetDir) => void pasteInto(targetDir ?? currentDir(), context),
    transferInto: async (paths, dstDir, op) => {
      // Paste toasts its own result; a drag-move/copy silently completing otherwise gives no
      // feedback at all for a long multi-file drag.
      const result = await transfer(paths, dstDir, op, context);
      if (result.succeeded > 0) {
        const verb = op === "copy" ? "Copied" : "Moved";
        toast.success(`${verb} ${result.succeeded} item${result.succeeded === 1 ? "" : "s"}`);
      }
    },
    uploadInto: upload.uploadInto,
    openUploadPicker: upload.openUploadPicker,
    openUploadFolderPicker: upload.openUploadFolderPicker,
    supportsFolderUpload: upload.supportsFolderUpload,

    startRename: (entry) => {
      setInlineError(null);
      patch(windowId, { inlineEdit: { kind: "rename", path: entry.path, initial: entry.name } });
    },
    startCreate: (kind) => {
      setInlineError(null);
      patch(windowId, { inlineEdit: { kind, initial: "" } });
    },
    cancelInline: () => {
      setInlineError(null);
      patch(windowId, { inlineEdit: null });
    },
    commitInline: async (value) => {
      const current = sliceRef.current;
      const edit = current?.inlineEdit;
      if (!current || !edit) return;
      const name = value.trim();
      if (edit.kind === "rename" && name === edit.initial) {
        patch(windowId, { inlineEdit: null });
        return;
      }
      const problem = validateEntryName(name, platform);
      if (problem) {
        setInlineError(problem);
        return;
      }
      setInlineError(null);
      const done = edit.kind === "rename"
        ? await renameEntry(edit.path, name, current.sep)
        : await createEntry(current.path, name, edit.kind === "new-folder" ? "folder" : "file", current.sep);
      if (done) patch(windowId, { inlineEdit: null });
    },

    trash: (entries) => {
      void deleteEntries(entries.map((e) => e.path), false, sliceRef.current?.sep ?? "/").then((outcome) => {
        // The host has no trash backend for these paths; permanent deletion is the only
        // remaining option, so offer it instead of leaving the entries in place silently.
        if (outcome.needsPermanent.length > 0) {
          setPendingDelete({
            paths: outcome.needsPermanent,
            names: outcome.needsPermanent.map((p) => p.split(/[/\\]/).pop() ?? p),
          });
        }
      });
    },
    confirmPermanentDelete: (entries) => {
      if (entries.length === 0) return;
      setPendingDelete({ paths: entries.map((e) => e.path), names: entries.map((e) => e.name) });
    },

    download: (entries) => void downloadEntries(entries),
    copyPath: (paths) => void copyTextLines(paths, "Path"),
    copyName: (names) => void copyTextLines(names, "Name"),
    togglePin: (path, name) => {
      const pins = useExplorerPinsStore.getState();
      if (pins.isPinned(path)) pins.unpin(path);
      else pins.pin({ path, name });
    },
    showProperties: (entry) => setProperties(entry),
  }), [windowId, patch, nav, context, platform, upload]);

  const runPermanentDelete = useCallback(() => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    void deleteEntries(target.paths, true, sliceRef.current?.sep ?? "/");
  }, [pendingDelete]);

  return {
    actions,
    dialogs: {
      collision: collisionPrompt.state,
      pendingDelete,
      permanentOverwrite: permanentOverwritePrompt.state,
      properties,
      inlineError,
      closeDelete: () => setPendingDelete(null),
      runPermanentDelete,
      closeProperties: () => setProperties(null),
      uploadInputs: upload.uploadInputs,
    },
  };
}
