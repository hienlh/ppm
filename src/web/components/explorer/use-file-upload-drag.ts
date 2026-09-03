/**
 * Hook for file upload and root-level drag & drop in the file tree.
 */
import { useCallback, useState, useRef } from "react";
import { useFileStore } from "@/stores/file-store";
import { getAuthToken, projectUrl } from "@/lib/api-client";
import { enterDragDepth, leaveDragDepth, resetDragDepth, type DragDepthCounter } from "@/components/os-explorer/dnd/drag-depth-counter";
import { isExternalFileDrag } from "./use-tree-row-dnd";
import { toast } from "sonner";

interface UseFileUploadDragOptions {
  projectName: string | undefined;
  setExpanded: (path: string, expanded: boolean) => void;
}

export function useFileUploadDrag({ projectName, setExpanded }: UseFileUploadDragOptions) {
  const [isRootDragOver, setIsRootDragOver] = useState(false);
  // `useRef<number>`'s `{ current }` shape already matches `DragDepthCounter` structurally.
  const rootDragCounter: DragDepthCounter = useRef(0);

  const uploadFiles = useCallback(async (targetDir: string, files: FileList) => {
    if (!projectName) return;
    const count = files.length;
    const label = count === 1 ? files[0]!.name : `${count} files`;
    const toastId = toast.loading(`Uploading ${label}…`);

    const form = new FormData();
    form.append("targetDir", targetDir);
    for (const file of files) form.append("files", file);
    const headers: HeadersInit = {};
    const token = getAuthToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    try {
      const res = await fetch(`${projectUrl(projectName)}/files/upload`, {
        method: "POST",
        headers,
        body: form,
      });
      if (!res.ok) {
        const json = await res.json();
        toast.error(`Upload failed: ${json.error ?? "Unknown error"}`, { id: toastId });
        return;
      }
      toast.success(`Uploaded ${label}`, { id: toastId });
      const store = useFileStore.getState();
      if (store.loadedPaths.has(targetDir)) {
        await store.invalidateFolder(projectName, targetDir);
      }
      if (targetDir) setExpanded(targetDir, true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed", { id: toastId });
    }
  }, [projectName, setExpanded]);

  function handleRootDragEnter(e: React.DragEvent) {
    const accepted = isExternalFileDrag(e);
    if (!accepted) return;
    e.preventDefault();
    if (enterDragDepth(rootDragCounter, accepted)) setIsRootDragOver(true);
  }
  function handleRootDragLeave(e: React.DragEvent) {
    // `leaveDragDepth` takes the *same* gate `handleRootDragEnter` used — an entry drag
    // never incremented this counter, so letting every entry-drag leave decrement it
    // unconditionally drove it negative, after which the OS-file-upload highlight could
    // never reach a positive count again.
    if (leaveDragDepth(rootDragCounter, isExternalFileDrag(e))) setIsRootDragOver(false);
  }
  function handleRootDragOver(e: React.DragEvent) {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
  function handleRootDrop(e: React.DragEvent) {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    resetDragDepth(rootDragCounter);
    setIsRootDragOver(false);
    if (e.dataTransfer.files.length > 0) uploadFiles("", e.dataTransfer.files);
  }

  return {
    uploadFiles,
    isRootDragOver,
    handleRootDragEnter,
    handleRootDragLeave,
    handleRootDragOver,
    handleRootDrop,
  };
}
