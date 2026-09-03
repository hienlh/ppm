/**
 * One file row inside the upload progress panel/sheet: name, relative path, size, progress
 * bar, state, and a per-row Cancel while it is still queued/uploading.
 */

import { AlertTriangle, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { UploadItem } from "./upload-store";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

export interface UploadBatchRowProps {
  item: UploadItem;
  onCancel(): void;
}

export function UploadBatchRow({ item, onCancel }: UploadBatchRowProps) {
  const pct = item.size > 0 ? Math.min(100, Math.round((item.bytesLoaded / item.size) * 100)) : 0;
  const active = item.state === "queued" || item.state === "uploading";
  const showsPath = item.relativePath !== item.name;

  return (
    <div className="flex flex-col gap-1 px-3 py-2" data-testid="upload-row" data-state={item.state}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-text">{item.name}</p>
          {showsPath && <p className="truncate text-xs text-text-2">{item.relativePath}</p>}
        </div>
        <span className="shrink-0 text-xs text-text-2">{formatBytes(item.size)}</span>
        {active ? (
          <button
            type="button"
            aria-label={`Cancel ${item.name}`}
            onClick={onCancel}
            className="flex size-11 shrink-0 items-center justify-center rounded-md can-hover:hover:bg-surface-elevated"
          >
            <X className="size-4 text-text-2" />
          </button>
        ) : (
          <span className="flex size-11 shrink-0 items-center justify-center" aria-label={item.state}>
            {item.state === "done" && <Check className="size-4 text-success" />}
            {item.state === "skipped" && <span className="text-xs text-text-2">Skipped</span>}
            {(item.state === "failed" || item.state === "cancelled") && (
              <AlertTriangle className="size-4 text-destructive" />
            )}
          </span>
        )}
      </div>

      {active && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-surface-elevated">
          <div
            className={cn(
              "h-full rounded-full bg-primary transition-[width]",
              item.state === "queued" && "w-0 opacity-40",
            )}
            style={item.state === "uploading" ? { width: `${pct}%` } : undefined}
          />
        </div>
      )}

      {(item.state === "failed" || item.state === "cancelled") && (
        <p className="text-xs text-destructive">
          {item.state === "cancelled" ? "Cancelled" : item.errorMessage ?? "Upload failed"}
        </p>
      )}
    </div>
  );
}
