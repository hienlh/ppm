import type { DesignShareChangedFiles } from "../../../../shared/design-share-types";

/**
 * The files reviewers now get that differ from the version they had, listed after a re-pin
 * so the owner can see anything that should not be in the design folder.
 */
export function ShareChangedFiles({ files }: { files: DesignShareChangedFiles | null }) {
  if (!files) {
    return <p className="text-sm text-text-2">The version this link was pinned to is no longer on disk, so the changes cannot be listed.</p>;
  }
  const groups: { title: string; names: string[] }[] = [
    { title: "Added", names: files.added },
    { title: "Changed", names: files.changed },
    { title: "Removed", names: files.removed },
  ].filter((g) => g.names.length > 0);
  if (groups.length === 0) return <p className="text-sm text-text-2">No files changed since the previous version.</p>;
  return (
    <div className="flex flex-col gap-2" data-testid="share-changed-files">
      {groups.map((g) => (
        <div key={g.title}>
          <p className="text-xs font-medium text-text-subtle">{g.title} ({g.names.length})</p>
          <ul className="mt-1 max-h-32 overflow-y-auto rounded-md border border-border bg-background px-2 py-1 font-mono text-xs">
            {g.names.map((n) => <li key={n} className="break-all py-0.5">{n}</li>)}
          </ul>
        </div>
      ))}
      {files.truncated && <p className="text-xs text-text-subtle">More files changed than are listed here.</p>}
    </div>
  );
}
