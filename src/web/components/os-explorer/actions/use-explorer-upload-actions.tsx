/**
 * Upload wiring for one explorer window: the hidden file/folder pickers and the action that
 * turns a drop or a pick into `uploadEntries` calls. Split out of `use-explorer-actions.ts` to
 * keep that file under the line cap — uploads are one more interruption-owning concern
 * alongside collision/delete/properties, not a different architecture.
 */

import { useCallback, type ReactNode } from "react";
import type { DroppedEntry } from "../upload/collect-dropped-entries";
import { useUploadPicker } from "../upload/use-upload-picker";
import type { TransferContext } from "./explorer-actions-clipboard";
import { uploadEntries } from "./explorer-actions-upload";

export interface ExplorerUploadActions {
  uploadInto(entries: DroppedEntry[], dstDir: string): Promise<void>;
  openUploadPicker(): void;
  openUploadFolderPicker(): void;
  supportsFolderUpload: boolean;
  /** Render once per window — the hidden `<input>` elements the pickers click. */
  uploadInputs: ReactNode;
}

export function useExplorerUploadActions(
  context: TransferContext,
  currentDir: () => string,
): ExplorerUploadActions {
  const uploadInto = useCallback(
    (entries: DroppedEntry[], dstDir: string) => uploadEntries(entries, dstDir, context.sep, context),
    [context],
  );

  const picker = useUploadPicker((entries) => void uploadInto(entries, currentDir()));

  return {
    uploadInto,
    openUploadPicker: picker.openFilePicker,
    openUploadFolderPicker: picker.openFolderPicker,
    supportsFolderUpload: picker.supportsFolderPicker,
    uploadInputs: picker.inputs,
  };
}
