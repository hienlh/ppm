import { useState, useCallback, useEffect } from "react";
import {
  GitBranch,
  Plus,
  RefreshCw,
  Trash2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Lock,
  AlertCircle,
  Check,
} from "lucide-react";
import { api, projectUrl } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { GitWorktree } from "../../../types/git";
import { CreateWorktreeDialog } from "./create-worktree-dialog";
import { cn } from "@/lib/utils";

interface GitWorktreePanelProps {
  projectName: string;
  /** Current project path — used to detect the active worktree */
  projectPath?: string;
}

/** Collapsible panel listing git worktrees with add/remove actions. */
export function GitWorktreePanel({ projectName, projectPath }: GitWorktreePanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<GitWorktree | null>(null);
  const [removing, setRemoving] = useState(false);

  const fetchWorktrees = useCallback(async () => {
    if (!projectName) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<GitWorktree[]>(
        `${projectUrl(projectName)}/git/worktrees`,
      );
      setWorktrees(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load worktrees");
    } finally {
      setLoading(false);
    }
  }, [projectName]);

  // Fetch when first expanded
  useEffect(() => {
    if (expanded) fetchWorktrees();
  }, [expanded, fetchWorktrees]);

  async function handleRemove(force = false) {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await api.post(`${projectUrl(projectName)}/git/worktree/remove`, {
        path: removeTarget.path,
        force,
      });
      setRemoveTarget(null);
      await fetchWorktrees();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove worktree");
      setRemoveTarget(null);
    } finally {
      setRemoving(false);
    }
  }

  async function handlePrune() {
    try {
      await api.post(`${projectUrl(projectName)}/git/worktree/prune`, {});
      await fetchWorktrees();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Prune failed");
    }
  }

  return (
    <div className="border-t border-border">
      {/* Section header */}
      <button
        type="button"
        className="flex items-center justify-between w-full px-3 py-2 hover:bg-muted/50 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-1.5">
          {expanded ? (
            <ChevronDown className="size-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 text-muted-foreground" />
          )}
          <span className="text-xs font-medium text-muted-foreground uppercase">
            Worktrees
          </span>
          {worktrees.length > 0 && (
            <span className="text-[10px] bg-muted text-muted-foreground rounded px-1">
              {worktrees.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {expanded && (
            <>
              <span
                role="button"
                tabIndex={0}
                className="flex items-center justify-center size-5 rounded text-muted-foreground hover:text-foreground transition-colors"
                onClick={(e) => { e.stopPropagation(); handlePrune(); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); handlePrune(); } }}
                title="Prune stale worktrees"
                aria-label="Prune stale worktrees"
              >
                <RefreshCw className={cn("size-3", loading && "animate-spin")} />
              </span>
              <span
                role="button"
                tabIndex={0}
                className="flex items-center justify-center size-5 rounded text-muted-foreground hover:text-foreground transition-colors"
                onClick={(e) => { e.stopPropagation(); setCreateOpen(true); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); setCreateOpen(true); } }}
                title="Add worktree"
                aria-label="Add worktree"
              >
                <Plus className="size-3" />
              </span>
            </>
          )}
        </div>
      </button>

      {/* Worktree list */}
      {expanded && (
        <div className="pb-1">
          {error && (
            <p className="text-xs text-destructive px-3 py-1">{error}</p>
          )}

          {loading && worktrees.length === 0 && (
            <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              <span className="text-xs">Loading worktrees...</span>
            </div>
          )}

          {!loading && worktrees.length === 0 && !error && (
            <p className="text-xs text-muted-foreground px-3 py-1">
              No worktrees found.
            </p>
          )}

          {worktrees.map((wt) => (
            <WorktreeRow
              key={wt.path}
              worktree={wt}
              isActive={!!projectPath && wt.path === projectPath}
              onRemove={() => setRemoveTarget(wt)}
            />
          ))}

          {/* Add button at bottom for thumb-zone access on mobile */}
          <button
            type="button"
            className="flex items-center gap-2 w-full px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="size-3.5" />
            Add worktree
          </button>
        </div>
      )}

      {/* Create worktree dialog / bottom sheet */}
      <CreateWorktreeDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectName={projectName}
        onCreated={fetchWorktrees}
      />

      {/* Remove confirmation dialog */}
      <Dialog open={!!removeTarget} onOpenChange={(o) => !o && setRemoveTarget(null)}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Remove Worktree</DialogTitle>
            <DialogDescription>
              Remove worktree at{" "}
              <code className="px-1 py-0.5 rounded bg-muted text-xs font-mono">
                {removeTarget?.path}
              </code>
              {removeTarget?.branch && (
                <> (branch: <strong>{removeTarget.branch}</strong>)</>
              )}
              ? The directory will be deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRemoveTarget(null)} disabled={removing}>
              Cancel
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleRemove(true)}
              disabled={removing}
            >
              {removing ? <Loader2 className="size-3 animate-spin" /> : "Force Remove"}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => handleRemove(false)}
              disabled={removing}
            >
              {removing ? <Loader2 className="size-3 animate-spin" /> : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  WorktreeRow                                                        */
/* ------------------------------------------------------------------ */

function WorktreeRow({
  worktree,
  isActive,
  onRemove,
}: {
  worktree: GitWorktree;
  isActive: boolean;
  onRemove: () => void;
}) {
  const label = worktree.branch || worktree.head.slice(0, 7) || "detached";
  // Show path relative to home dir if possible
  const shortPath = worktree.path.replace(/^\/home\/[^/]+/, "~");

  return (
    <div
      className={cn(
        "group flex items-center gap-2 px-3 py-1.5 hover:bg-muted/50 transition-colors",
        isActive && "bg-accent/10",
      )}
    >
      <GitBranch className="size-3.5 text-muted-foreground shrink-0" />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1 min-w-0">
          <span className="text-xs font-mono truncate" title={worktree.branch}>
            {label}
          </span>
          {isActive && (
            <Check className="size-3 text-green-500 shrink-0" />
          )}
          {worktree.isMain && (
            <span className="text-[10px] bg-muted text-muted-foreground rounded px-1 shrink-0">
              main
            </span>
          )}
          {worktree.locked && (
            <span title={worktree.lockReason ?? "locked"}>
              <Lock className="size-3 text-yellow-500 shrink-0" />
            </span>
          )}
          {worktree.prunable && (
            <span title="stale/prunable">
              <AlertCircle className="size-3 text-destructive shrink-0" />
            </span>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground truncate" title={worktree.path}>
          {shortPath}
        </p>
      </div>

      {/* Remove — hidden for main worktree */}
      {!worktree.isMain && (
        <button
          type="button"
          className="flex items-center justify-center size-5 rounded text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 can-hover:opacity-0 can-hover:group-hover:opacity-100 transition-all active:scale-95 shrink-0"
          onClick={onRemove}
          title="Remove worktree"
          aria-label="Remove worktree"
        >
          <Trash2 className="size-3" />
        </button>
      )}
    </div>
  );
}
