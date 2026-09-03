/**
 * Backs the toolbar/context-menu/mobile "Upload…" actions: a hidden native file input the
 * button clicks programmatically, so the browser's own picker chrome is used instead of a
 * custom one. A second hidden input with the non-standard `webkitdirectory` attribute gives
 * folder uploads on the browsers that support it (Chromium, Safari) — Firefox never
 * implemented it, and `supportsFolderPicker` is what lets a caller hide that trigger there
 * instead of offering a picker that silently behaves like a flat file picker.
 */

import { useRef, type ChangeEvent, type ReactNode } from "react";
import { capturePickedFiles } from "./capture-picked-files";
import type { DroppedEntry } from "./collect-dropped-entries";

export interface UploadPicker {
  supportsFolderPicker: boolean;
  openFilePicker(): void;
  openFolderPicker(): void;
  /** Render this once anywhere in the tree — the inputs are visually hidden. */
  inputs: ReactNode;
}

/** Non-standard but present on Chromium/WebKit's `<input>`; absent from the DOM lib types. */
interface DirectoryPickerInputProps {
  webkitdirectory?: string;
}

export function useUploadPicker(onFiles: (entries: DroppedEntry[]) => void): UploadPicker {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const supportsFolderPicker =
    typeof document !== "undefined" && "webkitdirectory" in document.createElement("input");

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    // Captures the live FileList into a plain array BEFORE clearing `value` (see
    // `capture-picked-files.ts`) — clearing first, so picking the exact same file/folder
    // again still fires `onChange`, would otherwise race Chromium emptying the list itself.
    const picked = capturePickedFiles(e.target.files, () => { e.target.value = ""; });
    if (picked.length === 0) return;
    const entries: DroppedEntry[] = picked.map((file) => ({
      file,
      // The folder picker sets `webkitRelativePath` ("folder/sub/file.txt"); a plain file
      // picker leaves it empty, so the bare name is the relative path.
      relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    }));
    onFiles(entries);
  };

  return {
    supportsFolderPicker,
    openFilePicker: () => fileInputRef.current?.click(),
    openFolderPicker: () => folderInputRef.current?.click(),
    inputs: (
      <>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={handleChange}
          data-testid="explorer-upload-file-input"
        />
        {supportsFolderPicker && (
          <input
            ref={folderInputRef}
            {...({ webkitdirectory: "" } satisfies DirectoryPickerInputProps)}
            type="file"
            multiple
            hidden
            onChange={handleChange}
            data-testid="explorer-upload-folder-input"
          />
        )}
      </>
    ),
  };
}
