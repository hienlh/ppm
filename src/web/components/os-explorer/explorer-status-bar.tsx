/** Item count, selection count and the selected size — the strip along the window's foot. */

import type { FsEntry } from "@/lib/fs-api";
import { formatSize } from "./format-file-meta";
import { totalSize } from "./sort-and-filter-entries";

export interface ExplorerStatusBarProps {
  /** Rows currently visible (after filtering). */
  entries: FsEntry[];
  selection: Set<string>;
  /** True when the server capped the listing, so the counts are a lower bound. */
  truncated: boolean;
}

export function ExplorerStatusBar({ entries, selection, truncated }: ExplorerStatusBarProps) {
  const selected = entries.filter((e) => selection.has(e.path));
  const parts = [`${entries.length}${truncated ? "+" : ""} item${entries.length === 1 ? "" : "s"}`];
  if (selected.length > 0) {
    parts.push(`${selected.length} selected`);
    const bytes = totalSize(selected);
    if (bytes > 0) parts.push(formatSize(bytes));
  }

  return (
    <div
      data-testid="explorer-status"
      className="flex shrink-0 items-center gap-2 border-t border-border bg-panel-2 px-2 py-1 text-[11px] text-text-subtle"
    >
      {parts.join(" · ")}
      {truncated && (
        <span className="ml-auto">Listing capped — narrow the filter to see the rest.</span>
      )}
    </div>
  );
}
