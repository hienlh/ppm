/**
 * The branch, and the one button that brings it level with its upstream:
 * Push ↑n, Pull ↓n, Sync ↓n ↑m, Publish, or Synced (which fetches).
 *
 * Always on screen, rather than in a menu, because "is my work on the remote"
 * is the question asked after every commit. Once nothing is left to commit it
 * becomes the panel's primary button.
 */
import { useState } from "react";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  CloudUpload,
  GitBranch,
  GitMerge,
  Loader2,
  RefreshCw,
} from "@/lib/icons";
import { cn } from "@/lib/utils";
import { syncIsPrimary, syncMode, type SyncMode } from "@/lib/git-changes-view";
import type { GitBranchState, GitOperation } from "../../../shared/git-changes";
import { BranchPicker } from "./branch-picker";

const ICON: Record<SyncMode, typeof Check> = {
  publish: CloudUpload,
  sync: RefreshCw,
  pull: ArrowDownToLine,
  push: ArrowUpFromLine,
  synced: Check,
};

const LABEL: Record<SyncMode, string> = {
  publish: "Publish",
  sync: "Sync",
  pull: "Pull",
  push: "Push",
  synced: "Synced",
};

function syncTitle(mode: SyncMode, branch: GitBranchState): string {
  const upstream = branch.upstream ?? "the remote";
  switch (mode) {
    case "publish":
      return branch.upstreamGone ? `${upstream} is gone from the remote: push the branch again` : "Push this branch to the remote and track it";
    case "sync":
      return `Pull ${branch.behind} and push ${branch.ahead} with ${upstream}`;
    case "pull":
      return `Pull ${branch.behind} from ${upstream}`;
    case "push":
      return `Push to ${upstream}`;
    case "synced":
      return `In sync with ${upstream} · click to fetch`;
  }
}

export function GitBranchRow({ projectName, branch, operation, files, busy, onSync }: {
  projectName: string;
  branch: GitBranchState;
  operation: GitOperation | null;
  /** How many files are changed: the sync button leads once there are none. */
  files: number;
  busy: string | null;
  onSync: (mode: SyncMode) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const mode = syncMode(branch);
  const primary = syncIsPrimary(mode, files);
  const name = branch.head ?? (branch.oid ? `${branch.oid.slice(0, 7)} (detached)` : "No commits yet");
  const Icon = mode ? ICON[mode] : Check;

  return (
    // `@container`: in a narrow sidebar the button drops its word and keeps its icon and counts, so the branch name keeps the room.
    <div className="@container relative flex min-h-[52px] md:min-h-10 shrink-0 items-center gap-1.5 border-b border-border-soft py-1.5 pl-2.5 pr-2">
      {operation ? (
        <span className="inline-flex h-10 md:h-7 min-w-0 items-center gap-1.5 text-sm md:text-[13px] font-medium">
          <GitMerge className="size-3.5 shrink-0 text-text-3" />
          <span className="truncate">{name}</span>
        </span>
      ) : (
        <button
          type="button"
          className="-ml-1.5 inline-flex h-11 md:h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-sm md:text-[13px] font-medium text-text hover:bg-surface-hover"
          onClick={() => setPickerOpen(true)}
          title="Switch branch"
        >
          <GitBranch className="size-3.5 shrink-0 text-text-3" />
          <span className="truncate">{name}</span>
          <ChevronDown className="size-3 shrink-0 text-text-3" />
        </button>
      )}
      <span className="flex-1" />
      {operation ? (
        <span className="text-xs text-text-3">{operation.kind === "merge" ? "merging" : `${operation.kind} stopped`}</span>
      ) : mode && (
        <button
          type="button"
          className={cn(
            "inline-flex h-11 md:h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border px-3 md:px-2 text-[13px] md:text-xs font-medium transition-colors disabled:opacity-60",
            primary
              ? "border-transparent bg-primary text-primary-foreground hover:bg-primary/90"
              : "border-border bg-background text-text-2 hover:border-text/25 hover:text-text",
          )}
          title={syncTitle(mode, branch)}
          disabled={!!busy}
          onClick={() => onSync(mode)}
        >
          {busy === mode || (busy === "fetch" && mode === "synced") ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Icon className="size-3.5" />
          )}
          <span className="sr-only @[16rem]:not-sr-only">{LABEL[mode]}</span>
          {(mode === "sync" || mode === "pull" || mode === "push") && (
            <span className="inline-flex gap-1.5 font-mono text-[11px] font-semibold">
              {branch.behind > 0 && (
                <span className="inline-flex items-center gap-px">
                  <ArrowDown className="size-3" />
                  {branch.behind}
                </span>
              )}
              {branch.ahead > 0 && (
                <span className={cn("inline-flex items-center gap-px", !primary && "text-primary")}>
                  <ArrowUp className="size-3" />
                  {branch.ahead}
                </span>
              )}
            </span>
          )}
        </button>
      )}
      {pickerOpen && <BranchPicker projectName={projectName} onClose={() => setPickerOpen(false)} />}
    </div>
  );
}
