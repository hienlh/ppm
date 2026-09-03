/**
 * Drag source + drop target wiring for one tree row.
 *
 * Two drags share this row: the tree's own internal move (a single relative path, its own
 * `application/x-ppm-path` MIME, its own project-scoped `/files/move` endpoint) and OS file
 * uploads — both pre-dating this hook and left byte-for-byte as they were. Layered on top,
 * the shared cross-surface entry-drag handlers let an explorer window or a different
 * project's tree drag onto (or receive a drag from) this same row.
 *
 * Every tree-origin drag dual-writes the legacy MIME, regardless of which project it started
 * in — so its mere presence is not enough to take the legacy project-scoped move: that path
 * treats the dragged path as relative to *this* row's project, which is wrong the moment the
 * drag started in a different project's tree (two panels, two active projects). The legacy
 * path is only safe when the absolute payload says the drag's own `projectName` matches this
 * row's; anything else — including a same-name coincidence across two different projects,
 * which the payload's `projectName` alone cannot tell apart from the real thing, so this
 * additionally requires it came from a tree — falls through to the shared absolute-path
 * handlers, which are correct for any project by construction.
 */

import { useRef, useState } from "react";
import { toast } from "sonner";
import { api, projectUrl } from "@/lib/api-client";
import { useFileStore, absoluteProjectPath } from "@/stores/file-store";
import { fsChanged } from "@/components/os-explorer/explorer-store";
import {
  decodeEntryDrag, ENTRY_DRAG_MIME, TREE_LEGACY_DRAG_MIME, type EntryDragPayload,
} from "@/components/os-explorer/dnd/entry-drag-payload";
import { getInFlightDrag } from "@/components/os-explorer/dnd/entry-drag-state";
import {
  enterDragDepth, leaveDragDepth, resetDragDepth, type DragDepthCounter,
} from "@/components/os-explorer/dnd/drag-depth-counter";
import { executeEntryDrop, type DropRunner } from "@/components/os-explorer/dnd/entry-drop-executor";
import { useEntryDragSource, type EntryDragSourceProps } from "@/components/os-explorer/dnd/use-entry-drag-source";
import { useEntryDropTarget } from "@/components/os-explorer/dnd/use-entry-drop-target";

/** Check if drag event is from OS files (not internal PPM drag). */
export function isExternalFileDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes("Files") && !e.dataTransfer.types.includes(TREE_LEGACY_DRAG_MIME);
}

/**
 * Pure routing decision, extracted for unit testing: given the decoded payload this row can
 * currently see (module ref on hover, real `dataTransfer` at drop) and whether the legacy
 * MIME is present at all, is the legacy project-scoped move safe to use? Only when the drag
 * both carries that MIME and genuinely originated in *this* project's tree.
 */
export function isSameProjectLegacyPayload(
  payload: EntryDragPayload | null,
  hasLegacyMime: boolean,
  projectName: string,
): boolean {
  return hasLegacyMime && payload?.origin === "tree" && payload.projectName === projectName;
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
  // `useRef<number>`'s `{ current }` shape already matches `DragDepthCounter` structurally.
  const dragCounter: DragDepthCounter = useRef(0);

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

  // dataTransfer values are unreadable during dragenter/dragover in Chromium — read the
  // module-level in-flight payload there (set at dragstart by the row that began the drag,
  // in this same document), and the real dataTransfer once it is actually readable, at drop.
  function legacyDragPayload(e: React.DragEvent): EntryDragPayload | null {
    return e.type === "drop" ? decodeEntryDrag(e.dataTransfer.getData(ENTRY_DRAG_MIME)) : getInFlightDrag();
  }

  function canAcceptDrop(e: React.DragEvent): boolean {
    if (isExternalFileDrag(e)) return true;
    return isSameProjectLegacyPayload(
      legacyDragPayload(e),
      e.dataTransfer.types.includes(TREE_LEGACY_DRAG_MIME),
      projectName,
    );
  }

  function handleNodeDragEnter(e: React.DragEvent) {
    if (!canAcceptDrop(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (enterDragDepth(dragCounter, true)) setIsDragOver(true);
  }
  function handleNodeDragLeave(e: React.DragEvent) {
    e.stopPropagation();
    if (leaveDragDepth(dragCounter, true)) setIsDragOver(false);
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
    resetDragDepth(dragCounter);
    setIsDragOver(false);

    // External file upload
    if (isExternalFileDrag(e)) {
      if (e.dataTransfer.files.length > 0) onFileDrop(dropTargetDir, e.dataTransfer.files);
      return;
    }

    // Internal tree move — canAcceptDrop already confirmed this drag's own projectName
    // matches this row's, so the legacy relative path is safe to resolve against it.
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
