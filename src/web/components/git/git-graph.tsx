import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import {
  RefreshCw,
  Loader2,
  GitBranch,
  Tag,
  Copy,
  GitMerge,
  Trash2,
  ArrowUpFromLine,
  ExternalLink,
  RotateCcw,
  CherryIcon,
  GripVertical,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { useTabStore } from "@/stores/tab-store";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { GitGraphData, GitCommit, GitBranch as GitBranchType } from "../../../types/git";

const LANE_COLORS = [
  "#4fc3f7", "#81c784", "#ffb74d", "#e57373",
  "#ba68c8", "#4dd0e1", "#aed581", "#ff8a65",
  "#f06292", "#7986cb",
];

const ROW_HEIGHT = 32;
const LANE_WIDTH = 20;
const NODE_RADIUS = 5;

interface GitGraphProps {
  metadata?: Record<string, unknown>;
}

export function GitGraph({ metadata }: GitGraphProps) {
  const projectName = metadata?.projectName as string | undefined;
  const [data, setData] = useState<GitGraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [dialogState, setDialogState] = useState<{
    type: "branch" | "tag" | null;
    hash?: string;
  }>({ type: null });
  const [inputValue, setInputValue] = useState("");
  const [selectedCommit, setSelectedCommit] = useState<GitCommit | null>(null);
  const [commitFiles, setCommitFiles] = useState<Array<{ path: string; additions: number; deletions: number }>>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const { openTab } = useTabStore();

  const fetchGraph = useCallback(async () => {
    if (!projectName) return;
    try {
      setLoading(true);
      const result = await api.get<GitGraphData>(
        `/api/git/graph/${encodeURIComponent(projectName)}?max=200`,
      );
      setData(result);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch graph");
    } finally {
      setLoading(false);
    }
  }, [projectName]);

  useEffect(() => {
    fetchGraph();
  }, [fetchGraph]);

  const gitAction = async (
    path: string,
    body: Record<string, unknown>,
  ) => {
    setActing(true);
    try {
      await api.post(path, { project: projectName, ...body });
      await fetchGraph();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setActing(false);
    }
  };

  const handleCheckout = (ref: string) =>
    gitAction("/api/git/checkout", { ref });
  const handleCherryPick = (hash: string) =>
    gitAction("/api/git/cherry-pick", { hash });
  const handleRevert = (hash: string) =>
    gitAction("/api/git/revert", { hash });
  const handleMerge = (source: string) =>
    gitAction("/api/git/merge", { source });
  const handleDeleteBranch = (name: string) =>
    gitAction("/api/git/branch/delete", { name });
  const handlePushBranch = (branch: string) =>
    gitAction("/api/git/push", { branch });
  const handleCreateBranch = (name: string, from: string) =>
    gitAction("/api/git/branch/create", { name, from });
  const handleCreateTag = (name: string, hash?: string) =>
    gitAction("/api/git/tag", { name, hash });

  const handleCreatePr = async (branch: string) => {
    if (!projectName) return;
    try {
      const result = await api.get<{ url: string | null }>(
        `/api/git/pr-url/${encodeURIComponent(projectName)}?branch=${encodeURIComponent(branch)}`,
      );
      if (result.url) {
        window.open(result.url, "_blank");
      }
    } catch {
      // silent
    }
  };

  const copyHash = (hash: string) => {
    navigator.clipboard.writeText(hash);
  };

  const selectCommit = async (commit: GitCommit) => {
    if (selectedCommit?.hash === commit.hash) {
      setSelectedCommit(null);
      return;
    }
    setSelectedCommit(commit);
    setLoadingDetail(true);
    try {
      const parent = commit.parents[0] ?? "";
      const result = await api.get<{ files: Array<{ path: string; additions: number; deletions: number }> }>(
        `/api/git/diff/${encodeURIComponent(projectName!)}?ref1=${parent}&ref2=${commit.hash}`,
      );
      setCommitFiles(result.files ?? []);
    } catch {
      setCommitFiles([]);
    } finally {
      setLoadingDetail(false);
    }
  };

  const openDiffForCommit = (commit: GitCommit) => {
    const ref1 = commit.parents[0];
    openTab({
      type: "git-diff",
      title: `Diff ${commit.abbreviatedHash}`,
      closable: true,
      metadata: {
        projectName,
        ref1: ref1 ?? undefined,
        ref2: commit.hash,
      },
    });
  };

  // Lane assignment algorithm
  const { laneMap, maxLane } = useMemo(() => {
    const map = new Map<string, number>();
    if (!data) return { laneMap: map, maxLane: 0 };

    let nextLane = 0;
    const activeLanes = new Map<string, number>();

    for (const commit of data.commits) {
      let lane = activeLanes.get(commit.hash);
      if (lane === undefined) {
        lane = nextLane++;
      }
      map.set(commit.hash, lane);
      activeLanes.delete(commit.hash);

      for (let i = 0; i < commit.parents.length; i++) {
        const parent = commit.parents[i]!;
        if (!activeLanes.has(parent)) {
          activeLanes.set(parent, i === 0 ? lane : nextLane++);
        }
      }
    }
    return { laneMap: map, maxLane: Math.max(nextLane - 1, 0) };
  }, [data]);

  const currentBranch = data?.branches.find((b) => b.current);

  // Build commit -> branch/tag label map
  const commitLabels = useMemo(() => {
    const labels = new Map<string, Array<{ name: string; type: "branch" | "tag" }>>();
    if (!data) return labels;
    for (const branch of data.branches) {
      const arr = labels.get(branch.commitHash) ?? [];
      arr.push({ name: branch.name, type: "branch" });
      labels.set(branch.commitHash, arr);
    }
    for (const commit of data.commits) {
      for (const ref of commit.refs) {
        if (ref.startsWith("tag: ")) {
          const tagName = ref.replace("tag: ", "");
          const arr = labels.get(commit.hash) ?? [];
          arr.push({ name: tagName, type: "tag" });
          labels.set(commit.hash, arr);
        }
      }
    }
    return labels;
  }, [data]);

  // Build SVG paths for connections
  const svgPaths = useMemo(() => {
    if (!data) return [];
    const paths: Array<{ d: string; color: string }> = [];

    for (let idx = 0; idx < data.commits.length; idx++) {
      const commit = data.commits[idx]!;
      const lane = laneMap.get(commit.hash) ?? 0;
      const color = LANE_COLORS[lane % LANE_COLORS.length]!;

      for (const parentHash of commit.parents) {
        const parentIdx = data.commits.findIndex((c) => c.hash === parentHash);
        if (parentIdx < 0) continue;
        const parentLane = laneMap.get(parentHash) ?? 0;
        const parentColor = LANE_COLORS[parentLane % LANE_COLORS.length]!;

        const x1 = lane * LANE_WIDTH + LANE_WIDTH / 2;
        const y1 = idx * ROW_HEIGHT + ROW_HEIGHT / 2;
        const x2 = parentLane * LANE_WIDTH + LANE_WIDTH / 2;
        const y2 = parentIdx * ROW_HEIGHT + ROW_HEIGHT / 2;

        let d: string;
        const isMerge = commit.parents.indexOf(parentHash) > 0;
        if (x1 === x2) {
          // Same lane: straight line
          d = `M ${x1} ${y1} L ${x2} ${y2}`;
        } else if (isMerge) {
          // Merge: curve at child (top), straight down to parent
          const curveEnd = y1 + ROW_HEIGHT;
          d = `M ${x1} ${y1} C ${x1} ${curveEnd} ${x2} ${y1} ${x2} ${curveEnd} L ${x2} ${y2}`;
        } else {
          // Branch/fork: straight down from child, curve at parent (bottom)
          const curveStart = y2 - ROW_HEIGHT;
          d = `M ${x1} ${y1} L ${x1} ${curveStart} C ${x1} ${y2} ${x2} ${curveStart} ${x2} ${y2}`;
        }
        // Use parent color for merge lines, commit color for first parent
        const lineColor = commit.parents.indexOf(parentHash) === 0 ? color : parentColor;
        paths.push({ d, color: lineColor });
      }
    }
    return paths;
  }, [data, laneMap]);

  const svgWidth = (maxLane + 1) * LANE_WIDTH + LANE_WIDTH;
  const svgHeight = (data?.commits.length ?? 0) * ROW_HEIGHT;

  // Resizable graph column — default: 6 lanes mobile, 10 lanes desktop
  const isMobile = typeof window !== "undefined" && window.innerWidth < 768;
  const defaultWidth = (isMobile ? 6 : 10) * LANE_WIDTH + LANE_WIDTH;
  const [graphColWidth, setGraphColWidth] = useState(defaultWidth);
  const isDragging = useRef(false);

  const handleDragStart = useCallback((startX: number) => {
    isDragging.current = true;
    const startW = graphColWidth;
    const onMove = (ev: MouseEvent | TouchEvent) => {
      if (!isDragging.current) return;
      const clientX = "touches" in ev ? ev.touches[0]!.clientX : ev.clientX;
      setGraphColWidth(Math.max(40, startW + clientX - startX));
    };
    const onUp = () => {
      isDragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onUp);
  }, [graphColWidth]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    handleDragStart(e.clientX);
  }, [handleDragStart]);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    handleDragStart(e.touches[0]!.clientX);
  }, [handleDragStart]);

  if (!projectName) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        No project selected.
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        <span className="text-sm">Loading git graph...</span>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-destructive text-sm">
        <p>{error}</p>
        <Button variant="outline" size="sm" onClick={fetchGraph}>
          Retry
        </Button>
      </div>
    );
  }

  function relativeDate(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 30) return `${diffDays}d ago`;
    const diffMonths = Math.floor(diffDays / 30);
    if (diffMonths < 12) return `${diffMonths}mo ago`;
    return `${Math.floor(diffMonths / 12)}y ago`;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <span className="text-sm font-medium">
          Git Graph{currentBranch ? ` - ${currentBranch.name}` : ""}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={fetchGraph}
          disabled={acting}
        >
          <RefreshCw className={loading ? "animate-spin" : ""} />
        </Button>
      </div>

      {error && (
        <div className="px-3 py-1.5 text-xs text-destructive bg-destructive/10">
          {error}
        </div>
      )}

      {/* Scrollable graph + commit list: mobile scrolls both, desktop only vertical */}
      <div className="flex-1 overflow-y-auto overflow-x-auto md:overflow-x-hidden">
        <div className="flex min-w-max md:min-w-0" style={{ height: `${svgHeight}px` }}>
          {/* Graph SVG column — sticky left with resize handle */}
          <div
            className="sticky left-0 z-10 shrink-0 bg-background"
            style={{ width: `${graphColWidth}px` }}
          >
            <svg width={graphColWidth} height={svgHeight}>
              {svgPaths.map((p, i) => (
                <path
                  key={i}
                  d={p.d}
                  stroke={p.color}
                  strokeWidth={2}
                  fill="none"
                />
              ))}
              {data?.commits.map((c, ci) => {
                const cLane = laneMap.get(c.hash) ?? 0;
                const cx = cLane * LANE_WIDTH + LANE_WIDTH / 2;
                const cy = ci * ROW_HEIGHT + ROW_HEIGHT / 2;
                const cColor = LANE_COLORS[cLane % LANE_COLORS.length]!;
                return (
                  <circle
                    key={c.hash}
                    cx={cx}
                    cy={cy}
                    r={NODE_RADIUS}
                    fill={cColor}
                    stroke="#0f1419"
                    strokeWidth={2}
                  />
                );
              })}
            </svg>
            {/* Drag handle — always visible on mobile, hover on desktop */}
            <div
              className="absolute top-0 right-0 w-3 md:w-2 h-full cursor-col-resize hover:bg-primary/20 flex items-center justify-center bg-primary/10 md:bg-transparent"
              onMouseDown={handleMouseDown}
              onTouchStart={handleTouchStart}
            >
              <GripVertical className="size-3 text-muted-foreground md:opacity-0 md:hover:opacity-100" />
            </div>
          </div>

          {/* Commit rows */}
          <div className="flex-1 min-w-[400px]">
            {data?.commits.map((commit, idx) => {
              const lane = laneMap.get(commit.hash) ?? 0;
              const color = LANE_COLORS[lane % LANE_COLORS.length]!;
              const labels = commitLabels.get(commit.hash) ?? [];
              const branchLabels = labels.filter((l) => l.type === "branch");
              const tagLabels = labels.filter((l) => l.type === "tag");

              return (
                <ContextMenu key={commit.hash}>
                  <ContextMenuTrigger asChild>
                    <div
                      className={`flex items-center hover:bg-muted/50 cursor-pointer text-sm border-b border-border/30 ${selectedCommit?.hash === commit.hash ? "bg-primary/10" : ""}`}
                      style={{ height: `${ROW_HEIGHT}px` }}
                      onClick={() => selectCommit(commit)}
                    >
                      <div className="flex items-center gap-2 flex-1 min-w-0 px-2">
                        <span className="font-mono text-xs text-muted-foreground w-14 shrink-0">
                          {commit.abbreviatedHash}
                        </span>
                        {branchLabels.map((label) => (
                          <BranchLabel
                            key={`branch-${label.name}`}
                            label={label}
                            color={color}
                            currentBranch={currentBranch}
                            onCheckout={handleCheckout}
                            onMerge={handleMerge}
                            onPush={handlePushBranch}
                            onCreatePr={handleCreatePr}
                            onDelete={handleDeleteBranch}
                          />
                        ))}
                        {tagLabels.map((label) => (
                          <span
                            key={`tag-${label.name}`}
                            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 bg-amber-500/20 text-amber-500 border border-amber-500/30"
                          >
                            <Tag className="size-2.5" />
                            {label.name}
                          </span>
                        ))}
                        <span className="flex-1 truncate">{commit.subject}</span>
                        <span className="text-xs text-muted-foreground shrink-0 hidden sm:inline">
                          {commit.authorName}
                        </span>
                        <span className="text-xs text-muted-foreground shrink-0 w-14 text-right">
                          {relativeDate(commit.authorDate)}
                        </span>
                      </div>
                    </div>
                  </ContextMenuTrigger>

                  <ContextMenuContent>
                    <ContextMenuItem onClick={() => handleCheckout(commit.hash)}>
                      Checkout
                    </ContextMenuItem>
                    <ContextMenuItem
                      onClick={() => {
                        setDialogState({ type: "branch", hash: commit.hash });
                        setInputValue("");
                      }}
                    >
                      <GitBranch className="size-3" />
                      Create Branch...
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onClick={() => handleCherryPick(commit.hash)}>
                      <CherryIcon className="size-3" />
                      Cherry Pick
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => handleRevert(commit.hash)}>
                      <RotateCcw className="size-3" />
                      Revert
                    </ContextMenuItem>
                    <ContextMenuItem
                      onClick={() => {
                        setDialogState({ type: "tag", hash: commit.hash });
                        setInputValue("");
                      }}
                    >
                      <Tag className="size-3" />
                      Create Tag...
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onClick={() => openDiffForCommit(commit)}>
                      View Diff
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => copyHash(commit.hash)}>
                      <Copy className="size-3" />
                      Copy Hash
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </div>
        </div>
      </div>

      {/* Commit detail panel — like vscode-git-graph */}
      {selectedCommit && (
        <div className="border-t bg-muted/30 max-h-[40%] overflow-auto">
          <div className="px-3 py-2 border-b flex items-center justify-between">
            <span className="text-sm font-medium truncate">
              {selectedCommit.abbreviatedHash} — {selectedCommit.subject}
            </span>
            <Button variant="ghost" size="icon-xs" onClick={() => setSelectedCommit(null)}>
              ✕
            </Button>
          </div>
          <div className="px-3 py-2 text-xs space-y-1">
            <div className="flex gap-4">
              <span className="text-muted-foreground">Author</span>
              <span>{selectedCommit.authorName} &lt;{selectedCommit.authorEmail}&gt;</span>
            </div>
            <div className="flex gap-4">
              <span className="text-muted-foreground">Date</span>
              <span>{new Date(selectedCommit.authorDate).toLocaleString()}</span>
            </div>
            <div className="flex gap-4">
              <span className="text-muted-foreground">Hash</span>
              <span className="font-mono cursor-pointer hover:text-primary" onClick={() => copyHash(selectedCommit.hash)}>
                {selectedCommit.hash}
              </span>
            </div>
            {selectedCommit.parents.length > 0 && (
              <div className="flex gap-4">
                <span className="text-muted-foreground">Parents</span>
                <span className="font-mono">{selectedCommit.parents.map(p => p.slice(0, 7)).join(", ")}</span>
              </div>
            )}
            {selectedCommit.body && (
              <div className="mt-2 p-2 bg-background rounded text-xs whitespace-pre-wrap">
                {selectedCommit.body}
              </div>
            )}
          </div>
          {/* Changed files */}
          <div className="px-3 py-1 border-t">
            <div className="text-xs text-muted-foreground py-1">
              {loadingDetail ? "Loading files..." : `${commitFiles.length} file${commitFiles.length !== 1 ? "s" : ""} changed`}
            </div>
            {commitFiles.map((file) => (
              <div
                key={file.path}
                className="flex items-center gap-2 py-0.5 text-xs hover:bg-muted/50 rounded px-1 cursor-pointer"
                onClick={() => openTab({
                  type: "git-diff",
                  title: `Diff ${file.path.split("/").pop()}`,
                  closable: true,
                  metadata: {
                    projectName,
                    ref1: selectedCommit.parents[0] ?? undefined,
                    ref2: selectedCommit.hash,
                    filePath: file.path,
                  },
                })}
              >
                <span className="flex-1 truncate font-mono">{file.path}</span>
                {file.additions > 0 && <span className="text-green-500">+{file.additions}</span>}
                {file.deletions > 0 && <span className="text-red-500">-{file.deletions}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Create Branch/Tag Dialog */}
      <Dialog
        open={dialogState.type !== null}
        onOpenChange={(open) => {
          if (!open) setDialogState({ type: null });
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialogState.type === "branch" ? "Create Branch" : "Create Tag"}
            </DialogTitle>
          </DialogHeader>
          <Input
            placeholder={
              dialogState.type === "branch" ? "Branch name" : "Tag name"
            }
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && inputValue.trim()) {
                if (dialogState.type === "branch") {
                  handleCreateBranch(inputValue.trim(), dialogState.hash!);
                } else {
                  handleCreateTag(inputValue.trim(), dialogState.hash);
                }
                setDialogState({ type: null });
              }
            }}
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialogState({ type: null })}
            >
              Cancel
            </Button>
            <Button
              disabled={!inputValue.trim()}
              onClick={() => {
                if (dialogState.type === "branch") {
                  handleCreateBranch(inputValue.trim(), dialogState.hash!);
                } else {
                  handleCreateTag(inputValue.trim(), dialogState.hash);
                }
                setDialogState({ type: null });
              }}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Branch label with its own context menu */
function BranchLabel({
  label,
  color,
  currentBranch,
  onCheckout,
  onMerge,
  onPush,
  onCreatePr,
  onDelete,
}: {
  label: { name: string; type: string };
  color: string;
  currentBranch: GitBranchType | undefined;
  onCheckout: (ref: string) => void;
  onMerge: (source: string) => void;
  onPush: (branch: string) => void;
  onCreatePr: (branch: string) => void;
  onDelete: (name: string) => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <span
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 cursor-context-menu"
          style={{
            backgroundColor: `${color}30`,
            color,
            border: `1px solid ${color}50`,
          }}
        >
          <GitBranch className="size-2.5" />
          {label.name}
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onCheckout(label.name)}>
          Checkout
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => onMerge(label.name)}
          disabled={label.name === currentBranch?.name}
        >
          <GitMerge className="size-3" />
          Merge into current
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onPush(label.name)}>
          <ArrowUpFromLine className="size-3" />
          Push
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onCreatePr(label.name)}>
          <ExternalLink className="size-3" />
          Create PR
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          onClick={() => onDelete(label.name)}
          disabled={label.name === currentBranch?.name}
        >
          <Trash2 className="size-3" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
