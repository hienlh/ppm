import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { ScrollArea } from "../ui/scroll-area.tsx";
import { api } from "../../lib/api-client.ts";
import { computeGraphLayout } from "../../lib/git-graph-layout.ts";
import { GitGraphRenderer, ROW_HEIGHT, LANE_WIDTH, H_PADDING } from "./git-graph-renderer.tsx";
import { CommitContextMenu } from "./commit-context-menu.tsx";
import type { GitGraphData } from "../../../types/git.ts";
import { useTabStore } from "../../stores/tab.store.ts";

interface Props {
  projectPath: string;
}

export function GitGraph({ projectPath }: Props) {
  const [data, setData] = useState<GitGraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { openTab } = useTabStore();

  useEffect(() => {
    setLoading(true);
    api
      .get<GitGraphData>(
        `/api/git/graph/${encodeURIComponent(projectPath)}`,
      )
      .then((res) => setData(res))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [projectPath]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-destructive text-sm px-4 text-center">
        {error}
      </div>
    );
  }

  if (!data || data.commits.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        No commits found
      </div>
    );
  }

  const layout = computeGraphLayout(data.commits);
  const maxLane = Math.max(0, ...Array.from(layout.values()).map((l) => l.lane));
  const svgWidth = H_PADDING * 2 + (maxLane + 1) * LANE_WIDTH;

  const handleCheckout = async (hash: string) => {
    try {
      await api.post(`/api/git/checkout`, { project: projectPath, ref: hash });
    } catch (e) {
      console.error("Checkout failed", e);
    }
  };

  const handleCherryPick = async (hash: string) => {
    try {
      await api.post(`/api/git/cherry-pick`, { project: projectPath, hash });
    } catch (e) {
      console.error("Cherry-pick failed", e);
    }
  };

  const handleRevert = async (hash: string) => {
    try {
      await api.post(`/api/git/revert`, { project: projectPath, hash });
    } catch (e) {
      console.error("Revert failed", e);
    }
  };

  const handleCreateBranch = (hash: string) => {
    const name = prompt("Branch name:");
    if (!name) return;
    api.post(`/api/git/branch/create`, { project: projectPath, name, from: hash }).catch(console.error);
  };

  const handleCreateTag = (hash: string) => {
    const name = prompt("Tag name:");
    if (!name) return;
    api.post(`/api/git/tag`, { project: projectPath, name, hash }).catch(console.error);
  };

  const handleCopyHash = (hash: string) => {
    navigator.clipboard.writeText(hash).catch(console.error);
  };

  const handleViewDiff = (hash: string) => {
    openTab({
      type: "git-diff",
      title: `Diff ${hash.slice(0, 7)}`,
      closable: true,
      metadata: { projectPath, ref: hash },
    });
  };

  return (
    <ScrollArea className="h-full w-full">
      <div className="min-w-0">
        {data.commits.map((commit, i) => {
          const cl = layout.get(commit.hash);
          const branchLabels = commit.refs.filter(
            (r) => r.includes("HEAD") || r.includes("refs/heads") || r.includes("refs/remotes"),
          );
          const shortLabels = branchLabels.map((r) =>
            r.replace("refs/heads/", "").replace("refs/remotes/", "").replace("HEAD -> ", ""),
          );

          return (
            <CommitContextMenu
              key={commit.hash}
              commit={commit}
              onCheckout={handleCheckout}
              onCreateBranch={handleCreateBranch}
              onCherryPick={handleCherryPick}
              onRevert={handleRevert}
              onCreateTag={handleCreateTag}
              onCopyHash={handleCopyHash}
              onViewDiff={handleViewDiff}
            >
              <div
                className="flex items-center gap-2 px-2 hover:bg-muted/50 cursor-pointer select-none"
                style={{ height: ROW_HEIGHT }}
              >
                {/* Graph SVG column for this row */}
                <div style={{ width: svgWidth, flexShrink: 0, height: ROW_HEIGHT, position: "relative" }}>
                  <svg
                    width={svgWidth}
                    height={ROW_HEIGHT}
                    style={{ position: "absolute", top: 0, left: 0, overflow: "visible" }}
                  >
                    {/* Render only this row's slice of the full graph */}
                    <g transform={`translate(0, ${-i * ROW_HEIGHT})`}>
                      <GitGraphRenderer commits={data.commits} layout={layout} maxLane={maxLane} />
                    </g>
                  </svg>
                </div>

                {/* Commit info */}
                <span className="font-mono text-xs text-muted-foreground shrink-0">
                  {commit.abbreviatedHash}
                </span>
                <span className="text-xs truncate flex-1">{commit.subject}</span>
                {shortLabels.length > 0 && (
                  <div className="flex gap-1 shrink-0">
                    {shortLabels.slice(0, 2).map((label) => (
                      <span
                        key={label}
                        className="text-[10px] px-1.5 py-0.5 rounded-sm font-mono truncate max-w-[80px]"
                        style={{ background: cl?.color + "33", color: cl?.color }}
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                )}
                <span className="text-[11px] text-muted-foreground shrink-0 hidden md:block">
                  {commit.authorName}
                </span>
                <span className="text-[11px] text-muted-foreground shrink-0 hidden lg:block">
                  {commit.authorDate ? new Date(commit.authorDate).toLocaleDateString() : ""}
                </span>
              </div>
            </CommitContextMenu>
          );
        })}
      </div>
    </ScrollArea>
  );
}
