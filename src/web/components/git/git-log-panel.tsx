import { useEffect, useState, useCallback, useRef } from "react";
import { Loader2, RefreshCw, GitCommitHorizontal } from "lucide-react";
import { api, projectUrl } from "@/lib/api-client";
import { useProjectStore } from "@/stores/project-store";
import { useShallow } from "zustand/react/shallow";
import { ScrollArea } from "@/components/ui/scroll-area";
import { GitRefBadge, buildRefBadges } from "./git-ref-badge";
import type { GitGraphData, GitCommit, GitBranch } from "../../../types/git";

const PAGE_SIZE = 100;

interface GitLogPanelProps {
  metadata?: Record<string, unknown>;
}

export function GitLogPanel({ metadata }: GitLogPanelProps) {
  const projectName = (metadata?.projectName as string) ??
    useProjectStore(useShallow((s) => s.activeProject))?.name;
  const [data, setData] = useState<GitGraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(async (skip = 0, append = false) => {
    if (!projectName) return;
    setLoading(true);
    try {
      const res = await api.get<GitGraphData>(
        `${projectUrl(projectName)}/git/graph?max=${PAGE_SIZE}&skip=${skip}`,
      );
      setData((prev) => {
        if (append && prev) {
          return {
            ...res,
            commits: [...prev.commits, ...res.commits],
          };
        }
        return res;
      });
      setHasMore(res.commits.length === PAGE_SIZE);
    } catch {
      /* silent */
    }
    setLoading(false);
  }, [projectName]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const loadMore = useCallback(() => {
    if (loading || !hasMore || !data) return;
    fetchData(data.commits.length, true);
  }, [loading, hasMore, data, fetchData]);

  // Infinite scroll: load more when near bottom
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    if (target.scrollHeight - target.scrollTop - target.clientHeight < 200) {
      loadMore();
    }
  }, [loadMore]);

  if (!projectName) {
    return (
      <div className="flex items-center justify-center h-full text-text-secondary text-sm">
        Select a project to view git log
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <GitCommitHorizontal className="size-4 text-text-secondary" />
        <span className="text-xs font-medium text-text-primary">Git Log</span>
        <span className="text-[10px] text-text-subtle">
          {data ? `${data.commits.length} commits` : ""}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => fetchData()}
          disabled={loading}
          className="p-1 rounded text-text-subtle hover:text-text-secondary transition-colors"
          title="Refresh"
        >
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Commit list */}
      {!data && loading ? (
        <div className="flex items-center justify-center h-full">
          <Loader2 className="size-5 animate-spin text-primary" />
        </div>
      ) : data && data.commits.length === 0 ? (
        <div className="flex items-center justify-center h-full text-text-secondary text-sm">
          No commits yet
        </div>
      ) : data ? (
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto min-h-0"
          onScroll={handleScroll}
        >
          {data.commits.map((commit) => (
            <CommitRow
              key={commit.hash}
              commit={commit}
              branches={data.branches}
              head={data.head}
            />
          ))}
          {loading && (
            <div className="flex items-center justify-center py-3">
              <Loader2 className="size-4 animate-spin text-text-subtle" />
            </div>
          )}
          {!hasMore && data.commits.length > 0 && (
            <div className="text-center text-[10px] text-text-subtle py-3">
              End of history
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function CommitRow({
  commit,
  branches,
  head,
}: {
  commit: GitCommit;
  branches: GitBranch[];
  head: string;
}) {
  const isHead = commit.hash === head;
  const badges = buildRefBadges(commit.hash, commit.refs, branches, head);

  return (
    <div
      className={`flex items-start gap-2 px-3 py-1.5 border-b border-border/50 hover:bg-surface-elevated transition-colors ${
        isHead ? "bg-primary/5" : ""
      }`}
    >
      {/* Commit dot */}
      <div className="flex items-center pt-1 shrink-0">
        <span
          className={`size-2.5 rounded-full border-2 ${
            isHead
              ? "border-primary bg-primary"
              : "border-text-subtle bg-transparent"
          }`}
        />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Ref badges row */}
        {badges.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 mb-0.5">
            {badges.map((badge) => (
              <GitRefBadge key={`${badge.name}-${badge.syncState}`} {...badge} />
            ))}
          </div>
        )}

        {/* Subject line */}
        <p className="text-xs text-text-primary truncate leading-snug">
          {commit.subject}
        </p>

        {/* Meta */}
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[10px] font-mono text-text-subtle">
            {commit.abbreviatedHash}
          </span>
          <span className="text-[10px] text-text-subtle truncate">
            {commit.authorName}
          </span>
          <span className="text-[10px] text-text-subtle shrink-0">
            {formatRelativeDate(commit.authorDate)}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Compact relative date: "2h", "3d", "Jan 5" */
function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = Date.now();
  const diff = now - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return date.toLocaleDateString("en", { month: "short", day: "numeric" });
}
