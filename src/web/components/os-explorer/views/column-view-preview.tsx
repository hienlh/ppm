/**
 * Preview pane for Column view — the file currently highlighted anywhere in the columns
 * (deepest column, or an earlier one the user clicked into without drilling).
 */

import type { FsEntry } from "@/lib/fs-api";
import { canOpenInPpm, extensionOf, viewerKindOf } from "../can-open-in-ppm";
import { formatDateTime, formatSize } from "../format-file-meta";
import { FileTypeIcon } from "../icons/file-type-icon";
import { ThumbnailImage } from "../icons/thumbnail-image";

export interface ColumnViewPreviewProps {
  entry: FsEntry | null;
  onOpen(entry: FsEntry): void;
}

export function ColumnViewPreview({ entry, onOpen }: ColumnViewPreviewProps) {
  if (!entry) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-text-subtle">
        Select a file to preview
      </div>
    );
  }

  const isImage = entry.type !== "directory" && viewerKindOf(entry.name) === "image";

  return (
    <div
      key={entry.path}
      className="flex h-full min-w-0 flex-col items-center gap-3 overflow-y-auto p-4 text-center"
    >
      <div className="flex h-24 w-24 shrink-0 items-center justify-center">
        {isImage ? (
          <ThumbnailImage entry={entry} size={96} />
        ) : (
          <FileTypeIcon name={entry.name} kind={entry.kind} className="size-16" />
        )}
      </div>
      <p className="w-full truncate text-sm font-medium text-text" title={entry.name}>
        {entry.name}
      </p>
      <dl className="w-full space-y-1 text-left text-xs text-text-2">
        <div className="flex justify-between gap-2">
          <dt className="text-text-subtle">Kind</dt>
          <dd className="truncate">{entry.type === "directory" ? "Folder" : extensionOf(entry.name) || "File"}</dd>
        </div>
        {entry.type !== "directory" && (
          <div className="flex justify-between gap-2">
            <dt className="text-text-subtle">Size</dt>
            <dd>{formatSize(entry.size)}</dd>
          </div>
        )}
        <div className="flex justify-between gap-2">
          <dt className="text-text-subtle">Modified</dt>
          <dd className="truncate">{formatDateTime(entry.modified)}</dd>
        </div>
      </dl>
      {canOpenInPpm(entry.name) && (
        <button
          type="button"
          onClick={() => onOpen(entry)}
          className="mt-2 w-full rounded border border-border bg-panel-2 py-1.5 text-xs font-medium text-text can-hover:hover:bg-surface-elevated"
        >
          Open
        </button>
      )}
    </div>
  );
}
