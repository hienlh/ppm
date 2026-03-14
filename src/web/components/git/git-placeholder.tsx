import { GitBranch, GitCommitHorizontal, FileDiff } from "lucide-react";

export function GitGraphPlaceholder({
  metadata,
}: {
  metadata?: Record<string, unknown>;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary">
      <GitBranch className="size-10 text-text-subtle" />
      <p className="text-sm">Git Graph — coming in Phase 6</p>
      {metadata?.projectName != null && (
        <p className="text-xs text-text-subtle">
          Project: {String(metadata.projectName)}
        </p>
      )}
    </div>
  );
}

export function GitStatusPlaceholder({
  metadata,
}: {
  metadata?: Record<string, unknown>;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary">
      <GitCommitHorizontal className="size-10 text-text-subtle" />
      <p className="text-sm">Git Status — coming in Phase 6</p>
      {metadata?.projectName != null && (
        <p className="text-xs text-text-subtle">
          Project: {String(metadata.projectName)}
        </p>
      )}
    </div>
  );
}

export function GitDiffPlaceholder({
  metadata,
}: {
  metadata?: Record<string, unknown>;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary">
      <FileDiff className="size-10 text-text-subtle" />
      <p className="text-sm">Git Diff — coming in Phase 6</p>
      {metadata?.projectName != null && (
        <p className="text-xs text-text-subtle">
          Project: {String(metadata.projectName)}
        </p>
      )}
    </div>
  );
}
