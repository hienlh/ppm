/**
 * Drag source + drop target wiring for one tree row.
 *
 * Two drags share this row: the tree's own internal move (a single relative path, its own
 * `application/x-ppm-path` MIME, its own project-scoped `/files/move` endpoint) and OS file
 * uploads — both pre-dating this hook and left byte-for-byte as they were. Layered on top,
 * the shared cross-surface entry-drag handlers let an explorer window or a different
 * project's tree drag onto (or receive a drag from) this same row. A tree-origin drag always
 * carries the legacy MIME (dual-written at drag start), so it is always routed to the
 * untouched internal-move path; only a drag with no legacy MIME reaches the shared handlers.
 */

import { useRef, useState } from "react";
import { toast } from "sonner";
import { api, projectUrl } from "@/lib/api-client";
import { useFileStore, absoluteProjectPath } from "@/stores/file-store";
import { fsChanged } from "@/components/os-explorer/explorer-store";
import { TREE_LEGACY_DRAG_MIME } from "@/components/os-explorer/dnd/entry-drag-payload";
import { executeEntryDrop, type DropRunner } from "@/components/os-explorer/dnd/entry-drop-executor";
import { useEntryDragSource, type EntryDragSourceProps } from "@/components/os-explorer/dnd/use-entry-drag-source";
import { useEntryDropTarget } from "@/components/os-explorer/dnd/use-entry-drop-target";

/** Check if drag event is from OS files (not internal PPM drag). */
export function isExternalFileDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes("Files") && !e.dataTransfer.types.includes(TREE_LEGACY_DRAG_MIME);
}

function parentDirOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

export interface TreeRowDndOptions {
  path: string;
  name: string;
  isDir: boolean;
  /** Flat rows: dropping on a file targets its parent directory. */
  effectivePath: string;
  isSelected: boolean;
  selectedFiles: string[];
  isExpanded: boolean;
  projectName: string;
  projectRoot: string | undefined;
  toggleExpand(projectName: string, path: string): void;
  onFileDrop(targetDir: string, files: FileList): void;
  /** Runs a cross-surface entry drop through the shared collision-prompt transfer. */
  transferRun: DropRunner;
}

export interface TreeRowDnd {
  entrySource: EntryDragSourceProps;
  containerHandlers: {
    onDragEnter(e: React.DragEvent): void;
    onDragLeave(e: React.DragEvent): void;
    onDragOver(e: React.DragEvent): void;
    onDrop(e: React.DragEvent): void;
  };
  /** True while this row is a claimed target of either drag kind — draw the ring from it. */
  isDragOver: boolean;
}

export function useTreeRowDnd(options: TreeRowDndOptions): TreeRowDnd {
  const {
    path, name, isDir, effectivePath, isSelected, selectedFiles, isExpanded,
    projectName, projectRoot, toggleExpand, onFileDrop, transferRun,
  } = options;

  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounter = useRef(0);

  // Absolute host paths — the address space an explorer window or another project's tree
  // shares with this one. A multi-selected drag carries the whole selection; a lone node
  // carries just itself, matching what the context menu would act on.
  const dragAbsolutePaths = (isSelected && selectedFiles.length > 1 ? selectedFiles : [path])
    .map((p) => (projectRoot ? absoluteProjectPath(projectRoot, p) : p));

  const entrySource = useEntryDragSource({
    paths: dragAbsolutePaths,
    origin: "tree",
    projectName,
    // The tree's own internal move keeps reading this single-path type exactly as before —
    // multi-select was never wired into it, and this dual-write does not change that.
    extraData: { [TREE_LEGACY_DRAG_MIME]: isDir ? `${path}/` : path },
  });

  const dropTargetDir = isDir ? effectivePath : parentDirOf(path);
  const dropTargetAbsolute = isDir && projectRoot ? absoluteProjectPath(projectRoot, dropTargetDir) : null;

  const entryTarget = useEntryDropTarget({
    targetDir: dropTargetAbsolute,
    onDropEntries: (payload, op, dstDir) => void executeEntryDrop(payload, dstDir, op, transferRun),
    springLoad: isDir && !isExpanded ? () => toggleExpand(projectName, path) : undefined,
  });

  function canAcceptDrop(e: React.DragEvent): boolean {
    return isExternalFileDrag(e) || e.dataTransfer.types.includes(TREE_LEGACY_DRAG_MIME);
  }

  function handleNodeDragEnter(e: React.DragEvent) {
    if (!canAcceptDrop(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (dragCounter.current === 1) setIsDragOver(true);
  }
  function handleNodeDragLeave(e: React.DragEvent) {
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDragOver(false);
  }
  function handleNodeDragOver(e: React.DragEvent) {
    if (!canAcceptDrop(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = isExternalFileDrag(e) ? "copy" : "move";
  }
  function handleNodeDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragOver(false);

    // External file upload
    if (isExternalFileDrag(e)) {
      if (e.dataTransfer.files.length > 0) onFileDrop(dropTargetDir, e.dataTransfer.files);
      return;
    }

    // Internal tree move
    const sourcePath = e.dataTransfer.getData(TREE_LEGACY_DRAG_MIME).replace(/\/$/, "");
    if (!sourcePath) return;
    // Prevent dropping into self or descendant
    if (sourcePath === dropTargetDir || dropTargetDir.startsWith(`${sourcePath}/`)) return;
    // Prevent no-op (already in this folder)
    const sourceParent = parentDirOf(sourcePath);
    if (sourceParent === dropTargetDir) return;

    const sourceName = sourcePath.includes("/") ? sourcePath.slice(sourcePath.lastIndexOf("/") + 1) : sourcePath;
    const destination = dropTargetDir ? `${dropTargetDir}/${sourceName}` : sourceName;
    api.post(`${projectUrl(projectName)}/files/move`, { source: sourcePath, destination })
      .then(() => {
        const store = useFileStore.getState();
        store.invalidateIndex();
        store.loadIndex(projectName);
        store.invalidateFolder(projectName, sourceParent);
        store.invalidateFolder(projectName, dropTargetDir);
        // An explorer window showing either folder must refresh too.
        if (projectRoot) {
          fsChanged(absoluteProjectPath(projectRoot, sourceParent), absoluteProjectPath(projectRoot, dropTargetDir));
        }
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Move failed");
      });
  }

  return {
    entrySource,
    isDragOver: isDragOver || entryTarget.isOver,
    containerHandlers: {
      onDragEnter: (e) => { if (canAcceptDrop(e)) handleNodeDragEnter(e); else entryTarget.handlers.onDragEnter(e); },
      onDragLeave: (e) => { if (canAcceptDrop(e)) handleNodeDragLeave(e); else entryTarget.handlers.onDragLeave(e); },
      onDragOver: (e) => { if (canAcceptDrop(e)) handleNodeDragOver(e); else entryTarget.handlers.onDragOver(e); },
      onDrop: (e) => { if (canAcceptDrop(e)) handleNodeDrop(e); else entryTarget.handlers.onDrop(e); },
    },
  };
}
