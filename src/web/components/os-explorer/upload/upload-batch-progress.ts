/**
 * Pure aggregation over one batch's items — overall bytes and counts for the panel header.
 * Split out of the store/UI so the arithmetic (weighting in-flight bytes, treating "skipped"
 * as complete) is unit-testable without zustand or a browser.
 */

import type { UploadItem } from "./upload-store";

export interface BatchProgressSummary {
  bytesLoaded: number;
  bytesTotal: number;
  /** Uploaded or intentionally skipped — both count toward "how much of the batch is over". */
  doneCount: number;
  failedCount: number;
  totalCount: number;
}

export function summarizeBatch(items: UploadItem[]): BatchProgressSummary {
  let bytesLoaded = 0;
  let bytesTotal = 0;
  let doneCount = 0;
  let failedCount = 0;

  for (const item of items) {
    bytesTotal += item.size;
    bytesLoaded += item.state === "done" || item.state === "skipped"
      ? item.size
      : Math.min(item.bytesLoaded, item.size);
    if (item.state === "done" || item.state === "skipped") doneCount++;
    if (item.state === "failed" || item.state === "cancelled") failedCount++;
  }

  return { bytesLoaded, bytesTotal, doneCount, failedCount, totalCount: items.length };
}
