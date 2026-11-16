import { ChevronRight } from "@/lib/icons";
import { FileIcon } from "@/lib/file-icons";
import type { PathEntry } from "@/lib/path-query-matches";

/**
 * Path mode's directory line, shown once above the list instead of on every row. It wraps
 * rather than truncating: on a touch screen there is no tooltip, so this line and the row's
 * own folder + name are how the full path gets read at all.
 */
export function PathModeHeader({ dir, folders, files, truncated }: {
  dir: string; folders: number; files: number;
  /** The host stopped listing at its cap, so there are more files than these. */
  truncated: boolean;
}) {
  const counts = [
    folders ? `${folders} folder${folders === 1 ? "" : "s"}` : "",
    files || truncated ? `${files}${truncated ? "+" : ""} file${files === 1 && !truncated ? "" : "s"}` : "",
  ].filter(Boolean).join(", ");
  return (
    <div className="flex items-start gap-2 border-b border-border/50 px-3 py-1.5 text-xs text-text-subtle" title={dir}>
      <FileIcon name={dir} kind="directory" open className="mt-px size-3.5" />
      <span className="min-w-0 flex-1 font-mono [overflow-wrap:anywhere]" data-testid="palette-path-dir">{dir}</span>
      {counts && <span className="shrink-0 whitespace-nowrap">{counts}</span>}
    </div>
  );
}

/**
 * One file or folder of path mode. The name is never cut: entries of one folder tend to share a
 * long prefix (`NX-6641-pass-ie-manual-…`), and an end ellipsis made them all read the same.
 * A wide palette shows most names on one line; a narrow one wraps them. Between the directory
 * above the list and the entry's own subfolder, the whole path is on screen.
 */
export function PathResultRow({ entry, selected, onClick }: { entry: PathEntry; selected: boolean; onClick: () => void }) {
  const folder = entry.kind === "folder";
  return (
    <button
      onClick={onClick}
      title={entry.path}
      data-path-entry={entry.kind}
      className={`flex items-start gap-3 w-full px-3 py-2 text-sm text-left transition-colors ${
        selected ? "bg-accent/15 text-text-primary" : "text-text-secondary hover:bg-surface-elevated"
      }`}
    >
      <FileIcon name={entry.name} kind={folder ? "directory" : "file"} className="mt-0.5" />
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {entry.relDir && <span className="text-text-subtle">{entry.relDir}</span>}
        <span className={folder ? "font-medium" : undefined}>{entry.name}</span>
      </span>
      {folder && <ChevronRight className="mt-0.5 size-4 shrink-0 text-text-subtle" aria-hidden />}
    </button>
  );
}
