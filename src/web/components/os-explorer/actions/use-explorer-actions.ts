/**
 * Binds the action modules to one window's slice and owns the state of the three
 * interruptions they need: the collision prompt, the permanent-delete confirmation and
 * the properties dialog.
 *
 * Prompts are modelled as promises resolved by the dialog, so the action modules stay
 * plain async functions with no React inside them.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import type { FsEntry } from "@/lib/fs-api";
import { useExplorerPinsStore } from "../explorer-pins-store";
import { useExplorerStore, type ExplorerSlice } from "../explorer-store";
import type { ExplorerNavigation } from "../use-explorer-navigation";
import { copyTextLines, downloadEntries, openEntryInPpm, openPathInNewWindow } from "./explorer-actions-open";
import {
  pasteInto, setClipboardPaths, transfer,
  type CollisionChoice, type CollisionRequest,
} from "./explorer-actions-clipboard";
import { createEntry, deleteEntries, renameEntry, validateEntryName } from "./explorer-actions-mutate";

export interface ExplorerActions {
  openEntry(entry: FsEntry): void;
  openInNewWindow(entry: FsEntry): void;
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
}

export interface ExplorerDialogState {
  collision: (CollisionRequest & { resolve(choice: CollisionChoice): void }) | null;
  pendingDelete: { paths: string[]; names: string[] } | null;
  properties: FsEntry | null;
  inlineError: string | null;
  closeDelete(): void;
  runPermanentDelete(): void;
  closeProperties(): void;
}

export function useExplorerActions(
  windowId: string,
  slice: ExplorerSlice | undefined,
  nav: ExplorerNavigation,
  platform: string | undefined,
): { actions: ExplorerActions; dialogs: ExplorerDialogState } {
  const patch = useExplorerStore((s) => s.patch);
  const [collision, setCollision] = useState<ExplorerDialogState["collision"]>(null);
  const [pendingDelete, setPendingDelete] = useState<ExplorerDialogState["pendingDelete"]>(null);
  const [properties, setProperties] = useState<FsEntry | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);

  const sliceRef = useRef(slice);
  sliceRef.current = slice;

  const context = useMemo(
    () => ({
      get sep() {
        return sliceRef.current?.sep ?? "/";
      },
      resolve: (request: CollisionRequest) =>
        new Promise<CollisionChoice>((resolve) => {
          setCollision({
            ...request,
            resolve: (choice) => {
              setCollision(null);
              resolve(choice);
            },
          });
        }),
    }),
    [],
  );

  const currentDir = () => sliceRef.current?.path ?? "";

  const actions = useMemo<ExplorerActions>(() => ({
    openEntry: (entry) => {
      if (entry.type === "directory") nav.go(entry.path);
      else openEntryInPpm(entry);
    },
    openInNewWindow: (entry) => {
      openPathInNewWindow(entry.type === "directory" ? entry.path : (sliceRef.current?.path ?? entry.path));
    },
    cut: (entries) => setClipboardPaths(entries.map((e) => e.path), "cut"),
    copy: (entries) => setClipboardPaths(entries.map((e) => e.path), "copy"),
    paste: (targetDir) => void pasteInto(targetDir ?? currentDir(), context),
    transferInto: async (paths, dstDir, op) => {
      await transfer(paths, dstDir, op, context);
    },

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
  }), [windowId, patch, nav, context, platform]);

  const runPermanentDelete = useCallback(() => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    void deleteEntries(target.paths, true, sliceRef.current?.sep ?? "/");
  }, [pendingDelete]);

  return {
    actions,
    dialogs: {
      collision,
      pendingDelete,
      properties,
      inlineError,
      closeDelete: () => setPendingDelete(null),
      runPermanentDelete,
      closeProperties: () => setProperties(null),
    },
  };
}
