import { Cloud, CloudOff, Tag, ArrowUp, ArrowDown } from "lucide-react";
import type { GitBranch } from "../../../types/git";
import { cn } from "@/lib/utils";

/** Deterministic color from branch name — 8 distinct hues */
const BRANCH_COLORS = [
  "#2563eb", // blue
  "#16a34a", // green
  "#d97706", // amber
  "#9333ea", // purple
  "#dc2626", // red
  "#0891b2", // cyan
  "#c026d3", // fuchsia
  "#ea580c", // orange
];

function hashColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return BRANCH_COLORS[Math.abs(hash) % BRANCH_COLORS.length]!;
}

export type RefSyncState = "synced" | "local-only" | "remote-only" | "ahead" | "behind";

interface GitRefBadgeProps {
  /** Display name (e.g. "main", "feature/login") */
  name: string;
  syncState: RefSyncState;
  /** True if this is HEAD */
  isHead?: boolean;
  /** True if this is a tag ref */
  isTag?: boolean;
  className?: string;
}

/** Merged branch/tag badge — colored border + light bg + black text */
export function GitRefBadge({ name, syncState, isHead, isTag, className }: GitRefBadgeProps) {
  const color = isTag ? "#d97706" : hashColor(name);

  const SyncIcon = isTag
    ? Tag
    : syncState === "synced"
      ? Cloud
      : syncState === "ahead"
        ? ArrowUp
        : syncState === "behind"
          ? ArrowDown
          : syncState === "remote-only"
            ? Cloud
            : CloudOff;

  const title = isTag
    ? `Tag: ${name}`
    : syncState === "synced"
      ? `${name} — synced with remote`
      : syncState === "ahead"
        ? `${name} — ahead of remote`
        : syncState === "behind"
          ? `${name} — behind remote`
          : syncState === "remote-only"
            ? `${name} — remote only`
            : `${name} — local only`;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-tight max-w-[220px]",
        isHead && "ring-1 ring-offset-1 ring-offset-background",
        syncState === "remote-only" && "opacity-70",
        className,
      )}
      style={{
        borderColor: color,
        backgroundColor: color + "1A", // ~10% opacity
        color: "#1a1a1a",
        // HEAD ring color
        ...(isHead ? { ["--tw-ring-color" as string]: color } : {}),
      }}
      title={title}
    >
      <SyncIcon className="size-3 shrink-0" style={{ color }} />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** Merge raw commit refs + branch data into deduplicated badge props */
export function buildRefBadges(
  commitHash: string,
  refs: string[],
  branches: GitBranch[],
  head: string,
): GitRefBadgeProps[] {
  const badges: GitRefBadgeProps[] = [];
  const isHead = commitHash === head;

  // Collect tags from refs
  for (const ref of refs) {
    if (ref.startsWith("tag: ")) {
      badges.push({ name: ref.slice(5), syncState: "synced", isTag: true });
    }
  }

  // Group branches by logical name (strip remotes/origin/ prefix)
  const branchesOnCommit = branches.filter((b) => b.commitHash === commitHash);
  const localBranches = branchesOnCommit.filter((b) => !b.remote);
  const remoteBranches = branchesOnCommit.filter((b) => b.remote);

  // Build set of remote branch names that have a local counterpart
  const localNames = new Set(localBranches.map((b) => b.name));
  const mergedRemoteNames = new Set<string>();

  // Add local branches with sync state
  for (const local of localBranches) {
    let syncState: RefSyncState = "local-only";
    if (local.remotes.length > 0) {
      // Has remote tracking
      if (local.ahead > 0 && local.behind === 0) syncState = "ahead";
      else if (local.behind > 0 && local.ahead === 0) syncState = "behind";
      else syncState = "synced";
    }
    badges.push({
      name: local.name,
      syncState,
      isHead: isHead && local.current,
    });
    // Mark corresponding remote names as merged
    for (const remote of remoteBranches) {
      const stripped = remote.name.replace(/^remotes\//, "");
      const slashIdx = stripped.indexOf("/");
      if (slashIdx < 0) continue;
      const remoteBranchName = stripped.slice(slashIdx + 1);
      if (remoteBranchName === local.name) {
        mergedRemoteNames.add(remote.name);
      }
    }
  }

  // Add remote-only branches (not merged with any local)
  for (const remote of remoteBranches) {
    if (mergedRemoteNames.has(remote.name)) continue;
    // Strip "remotes/" prefix for display, keep "origin/..." format
    const displayName = remote.name.replace(/^remotes\//, "");
    badges.push({ name: displayName, syncState: "remote-only" });
  }

  return badges;
}
