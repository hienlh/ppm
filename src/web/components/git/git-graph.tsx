import { useState, useRef, useCallback } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LANE_WIDTH, ROW_HEIGHT } from "./git-graph-constants";
import { useGitGraph } from "./use-git-graph";
import { useColumnResize } from "./use-column-resize";
import { GitGraphToolbar } from "./git-graph-toolbar";
import { GitGraphSvg } from "./git-graph-svg";
import { GitGraphRow } from "./git-graph-row";
import { GitGraphDetail } from "./git-graph-detail";
import { GitGraphDialog } from "./git-graph-dialog";
import { GitGraphSettingsDialog } from "./git-graph-settings-dialog";

interface GitGraphProps {
  metadata?: Record<string, unknown>;
}

export function GitGraph({ metadata }: GitGraphProps) {
  const projectName = metadata?.projectName as string | undefined;
  const g = useGitGraph(projectName);
  const [dialogState, setDialogState] = useState<{
    type: "branch" | "tag" | null;
    hash?: string;
  }>({ type: null });
  const [showSettings, setShowSettings] = useState(false);

  // Resizable graph column — use ref to avoid stale closure
  const isMobile = typeof window !== "undefined" && window.innerWidth < 768;
  const defaultGraphW = (isMobile ? 6 : 10) * LANE_WIDTH + LANE_WIDTH;
  const [graphColWidth, setGraphColWidth] = useState(defaultGraphW);
  const graphWidthRef = useRef(defaultGraphW);
  graphWidthRef.current = graphColWidth;
  const graphDragging = useRef(false);

  const startGraphResize = (startX: number) => {
    graphDragging.current = true;
    const startW = graphWidthRef.current;
    const onMove = (ev: MouseEvent | TouchEvent) => {
      if (!graphDragging.current) return;
      const cx = "touches" in ev ? ev.touches[0]!.clientX : ev.clientX;
      setGraphColWidth(Math.max(40, startW + cx - startX));
    };
    const onUp = () => {
      graphDragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onUp);
  };

  // Resizable table columns (Date, Author, Commit)
  const { widths: colW, startResize } = useColumnResize({ date: 80, author: 120, commit: 70 });

  // Infinite scroll — ref-based to avoid stale closure
  const loadMoreRef = useRef(g.loadMore);
  loadMoreRef.current = g.loadMore;
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
      loadMoreRef.current();
    }
  }, []);

  if (!projectName) return <EmptyState msg="No project selected." />;
  if (g.loading && !g.data) return <LoadingState />;
  if (g.error && !g.data) return <ErrorState error={g.error} onRetry={g.fetchGraph} />;

  return (
    <div className="flex flex-col h-full">
      <GitGraphToolbar
        branches={g.data?.branches ?? []} branchFilter={g.branchFilter}
        onBranchFilterChange={g.setBranchFilter} searchQuery={g.searchQuery}
        onSearchQueryChange={g.setSearchQuery} showSearch={g.showSearch}
        onToggleSearch={() => g.setShowSearch(!g.showSearch)}
        onFetch={g.fetchFromRemotes} onRefresh={g.fetchGraph}
        onOpenSettings={() => setShowSettings(true)}
        loading={g.loading} acting={g.acting} projectName={projectName}
      />
      {g.error && <div className="px-3 py-1.5 text-xs text-destructive bg-destructive/10">{g.error}</div>}

      <div className="flex-1 overflow-auto" onScroll={handleScroll}>
        <div className="flex min-w-max md:min-w-0">
          {/* Graph SVG column — overflow-hidden clips lanes beyond column width */}
          <div className="sticky left-0 z-10 shrink-0 bg-background relative overflow-hidden" style={{ width: `${graphColWidth}px` }}>
            <div className="text-[11px] font-semibold text-muted-foreground px-2 border-b bg-background sticky top-0 z-20"
              style={{ height: `${ROW_HEIGHT}px`, lineHeight: `${ROW_HEIGHT}px` }}>Graph</div>
            <GitGraphSvg commits={g.filteredCommits} laneMap={g.filteredLanes.laneMap}
              svgPaths={g.svgPaths} width={(g.filteredLanes.maxLane + 2) * LANE_WIDTH} height={g.svgHeight} headHash={g.headHash} />
            <div className="absolute top-0 right-0 w-1.5 h-full cursor-col-resize hover:bg-primary/30"
              onMouseDown={(e) => { e.preventDefault(); startGraphResize(e.clientX); }}
              onTouchStart={(e) => startGraphResize(e.touches[0]!.clientX)} />
          </div>

          {/* Commit table */}
          <div className="flex-1 min-w-[400px]">
            <table className="w-full border-collapse text-xs" style={{ tableLayout: "fixed" }}>
              <colgroup>
                <col />
                <col style={{ width: `${colW.date}px` }} />
                <col style={{ width: `${colW.author}px` }} />
                <col style={{ width: `${colW.commit}px` }} />
              </colgroup>
              <thead className="sticky top-0 z-10 bg-background">
                <tr className="border-b text-[11px] font-semibold text-muted-foreground" style={{ height: `${ROW_HEIGHT}px` }}>
                  <th className="text-left px-2 font-semibold">Description</th>
                  <ResizableTh label="Date" colKey="date" onStartResize={startResize} />
                  <ResizableTh label="Author" colKey="author" onStartResize={startResize} />
                  <th className="text-left px-2 font-semibold">Commit</th>
                </tr>
              </thead>
              <tbody>
                {g.filteredCommits.map((commit) => (
                  <GitGraphRow key={commit.hash} commit={commit}
                    lane={g.filteredLanes.laneMap.get(commit.hash) ?? 0}
                    isSelected={g.selectedCommit?.hash === commit.hash}
                    isHead={commit.hash === g.headHash}
                    labels={g.commitLabels.get(commit.hash) ?? []}
                    currentBranch={g.currentBranch}
                    onSelect={() => g.selectCommit(commit)}
                    onCheckout={g.handleCheckout} onCherryPick={g.handleCherryPick}
                    onRevert={g.handleRevert} onMerge={g.handleMerge}
                    onDeleteBranch={g.handleDeleteBranch} onPushBranch={g.handlePushBranch}
                    onCreatePr={g.handleCreatePr}
                    onOpenCreateBranch={(h) => setDialogState({ type: "branch", hash: h })}
                    onOpenCreateTag={(h) => setDialogState({ type: "tag", hash: h })}
                    onOpenDiff={() => g.openDiffForCommit(commit)}
                    onCopyHash={() => g.copyHash(commit.hash)} />
                ))}
              </tbody>
            </table>
            {g.loadingMore && (
              <div className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Loading more commits...
              </div>
            )}
            {!g.hasMore && g.data && g.data.commits.length > 0 && (
              <div className="text-center py-2 text-xs text-muted-foreground">
                {g.data.commits.length} commits loaded
              </div>
            )}
          </div>
        </div>
      </div>

      {g.selectedCommit && projectName && (
        <GitGraphDetail commit={g.selectedCommit} files={g.commitFiles}
          loadingDetail={g.loadingDetail} projectName={projectName}
          onClose={() => g.setSelectedCommit(null)} copyHash={g.copyHash} />
      )}
      <GitGraphDialog type={dialogState.type} hash={dialogState.hash}
        onClose={() => setDialogState({ type: null })}
        onCreateBranch={g.handleCreateBranch} onCreateTag={g.handleCreateTag} />
      <GitGraphSettingsDialog open={showSettings} onClose={() => setShowSettings(false)}
        projectName={projectName} branches={g.data?.branches ?? []} />
    </div>
  );
}

function ResizableTh({ label, colKey, onStartResize }: {
  label: string; colKey: string; onStartResize: (key: string, x: number) => void;
}) {
  return (
    <th className="text-left px-2 font-semibold relative">
      {label}
      <div className="absolute top-0 right-0 w-1.5 h-full cursor-col-resize hover:bg-primary/30"
        onMouseDown={(e) => { e.preventDefault(); onStartResize(colKey, e.clientX); }}
        onTouchStart={(e) => onStartResize(colKey, e.touches[0]!.clientX)} />
    </th>
  );
}

function EmptyState({ msg }: { msg: string }) {
  return <div className="flex items-center justify-center h-full text-muted-foreground text-sm">{msg}</div>;
}
function LoadingState() {
  return (
    <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
      <Loader2 className="size-5 animate-spin" /><span className="text-sm">Loading git graph...</span>
    </div>
  );
}
function ErrorState({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 text-destructive text-sm">
      <p>{error}</p><Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
    </div>
  );
}
