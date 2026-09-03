/**
 * One batch's contents: header (destination + overall progress + Cancel all/Close) and the
 * per-file rows. Shared by the desktop floating card and the mobile sheet — only the outer
 * chrome differs between them (see `upload-progress-panel.tsx`).
 */

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { summarizeBatch } from "./upload-batch-progress";
import { UploadBatchRow } from "./upload-batch-row";
import type { UploadBatch } from "./upload-store";
import { useUploadStore } from "./upload-store";

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface UploadBatchCardProps {
  batch: UploadBatch;
}

export function UploadBatchCard({ batch }: UploadBatchCardProps) {
  const cancelItem = useUploadStore((s) => s.cancelItem);
  const cancelBatch = useUploadStore((s) => s.cancelBatch);
  const dismissBatch = useUploadStore((s) => s.dismissBatch);
  const summary = summarizeBatch(batch.items);
  const settled = batch.settled;
  const pct = summary.bytesTotal > 0 ? Math.round((summary.bytesLoaded / summary.bytesTotal) * 100) : 0;

  return (
    <div className="w-full overflow-hidden rounded-lg border border-border bg-panel shadow-lg" data-testid="upload-batch-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text">
            {settled
              ? `${summary.doneCount}/${summary.totalCount} uploaded${summary.failedCount > 0 ? `, ${summary.failedCount} failed` : ""}`
              : `Uploading ${summary.totalCount} item${summary.totalCount === 1 ? "" : "s"}… ${pct}%`}
          </p>
          <p className="truncate text-xs text-text-2">{formatMb(summary.bytesLoaded)} / {formatMb(summary.bytesTotal)}</p>
        </div>
        {settled ? (
          <Button variant="ghost" size="sm" className="h-11 shrink-0" onClick={() => dismissBatch(batch.id)}>
            Close
          </Button>
        ) : (
          <button
            type="button"
            aria-label="Cancel all"
            onClick={() => cancelBatch(batch.id)}
            className="flex size-11 shrink-0 items-center justify-center rounded-md can-hover:hover:bg-surface-elevated"
          >
            <X className="size-4 text-text-2" />
          </button>
        )}
      </div>

      <div className="max-h-64 divide-y divide-border overflow-y-auto">
        {batch.items.map((item) => (
          <UploadBatchRow key={item.id} item={item} onCancel={() => cancelItem(batch.id, item.id)} />
        ))}
      </div>
    </div>
  );
}
