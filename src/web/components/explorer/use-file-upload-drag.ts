/**
 * Hook for file upload and root-level drag & drop in the file tree.
 */
import { useCallback, useState, useRef } from "react";
import { useFileStore } from "@/stores/file-store";
import { getAuthToken, projectUrl } from "@/lib/api-client";
import { isExternalFileDrag } from "./tree-node";

interface UseFileUploadDragOptions {
  projectName: string | undefined;
  setExpanded: (path: string, expanded: boolean) => void;
}

export function useFileUploadDrag({ projectName, setExpanded }: UseFileUploadDragOptions) {
  const [isRootDragOver, setIsRootDragOver] = useState(false);
  const rootDragCounter = useRef(0);

  const uploadFiles = useCallback(async (targetDir: string, files: FileList) => {
    if (!projectName) return;
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
        console.error("Upload failed:", json.error);
      }
      const store = useFileStore.getState();
      if (store.loadedPaths.has(targetDir)) {
        await store.invalidateFolder(projectName, targetDir);
      }
      if (targetDir) setExpanded(targetDir, true);
    } catch (e) {
      console.error("Upload error:", e);
    }
  }, [projectName, setExpanded]);

  function handleRootDragEnter(e: React.DragEvent) {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    rootDragCounter.current++;
    if (rootDragCounter.current === 1) setIsRootDragOver(true);
  }
  function handleRootDragLeave() {
    rootDragCounter.current--;
    if (rootDragCounter.current === 0) setIsRootDragOver(false);
  }
  function handleRootDragOver(e: React.DragEvent) {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
  function handleRootDrop(e: React.DragEvent) {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    rootDragCounter.current = 0;
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
