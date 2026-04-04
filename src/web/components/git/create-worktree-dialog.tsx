import { useState, useEffect } from "react";
import { Loader2, X } from "lucide-react";
import { api, projectUrl } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { GitBranch } from "../../../types/git";
import { cn } from "@/lib/utils";

interface CreateWorktreeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectName: string;
  onCreated: () => void;
}

type BranchMode = "existing" | "new";

/** Mobile bottom sheet + desktop dialog for creating a git worktree. */
export function CreateWorktreeDialog({
  open,
  onOpenChange,
  projectName,
  onCreated,
}: CreateWorktreeDialogProps) {
  const [worktreePath, setWorktreePath] = useState("");
  const [branchMode, setBranchMode] = useState<BranchMode>("new");
  const [newBranch, setNewBranch] = useState("");
  const [existingBranch, setExistingBranch] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch available branches when dialog opens
  useEffect(() => {
    if (!open || !projectName) return;
    api
      .get<GitBranch[]>(`${projectUrl(projectName)}/git/branches`)
      .then((data) => {
        const local = data.filter((b) => !b.remote).map((b) => b.name);
        setBranches(local);
        if (local.length > 0 && !existingBranch) {
          setExistingBranch(local[0]!);
        }
      })
      .catch(() => setBranches([]));
  }, [open, projectName]);

  function reset() {
    setWorktreePath("");
    setBranchMode("new");
    setNewBranch("");
    setError(null);
  }

  function handleClose() {
    reset();
    onOpenChange(false);
  }

  async function handleSubmit() {
    if (!worktreePath.trim()) {
      setError("Worktree path is required");
      return;
    }
    const selectedBranch = branchMode === "existing" ? existingBranch : undefined;
    const selectedNewBranch = branchMode === "new" && newBranch.trim() ? newBranch.trim() : undefined;

    setLoading(true);
    setError(null);
    try {
      await api.post(`${projectUrl(projectName)}/git/worktree/add`, {
        path: worktreePath.trim(),
        branch: selectedBranch,
        newBranch: selectedNewBranch,
      });
      onCreated();
      handleClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create worktree");
    } finally {
      setLoading(false);
    }
  }

  const formContent = (
    <div className="space-y-4">
      {error && (
        <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md">{error}</p>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="wt-path">Worktree Path</Label>
        <Input
          id="wt-path"
          placeholder="../my-feature"
          value={worktreePath}
          onChange={(e) => setWorktreePath(e.target.value)}
          autoFocus
          className="w-full"
        />
        <p className="text-xs text-muted-foreground">
          Relative or absolute path for the new worktree directory
        </p>
      </div>

      <div className="space-y-2">
        <Label>Branch</Label>
        <div className="flex gap-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              checked={branchMode === "new"}
              onChange={() => setBranchMode("new")}
              className="accent-primary"
            />
            <span className="text-sm">Create new branch</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              checked={branchMode === "existing"}
              onChange={() => setBranchMode("existing")}
              className="accent-primary"
            />
            <span className="text-sm">Use existing branch</span>
          </label>
        </div>

        {branchMode === "new" ? (
          <Input
            placeholder="feature/my-branch"
            value={newBranch}
            onChange={(e) => setNewBranch(e.target.value)}
            className="w-full"
          />
        ) : (
          <select
            value={existingBranch}
            onChange={(e) => setExistingBranch(e.target.value)}
            className="w-full h-9 px-3 rounded-md border border-input bg-transparent text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {branches.length === 0 && (
              <option value="">No branches available</option>
            )}
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );

  const footer = (
    <div className="flex gap-2 justify-end pt-2">
      <Button variant="outline" size="sm" onClick={handleClose} disabled={loading}>
        Cancel
      </Button>
      <Button
        size="sm"
        onClick={handleSubmit}
        disabled={loading || !worktreePath.trim()}
      >
        {loading ? <Loader2 className="size-3 animate-spin mr-1" /> : null}
        Create Worktree
      </Button>
    </div>
  );

  return (
    <>
      {/* Desktop: centered dialog */}
      <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
        <DialogContent className="hidden md:grid sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Worktree</DialogTitle>
          </DialogHeader>
          {formContent}
          <DialogFooter>{footer}</DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Mobile: bottom sheet */}
      {open && (
        <div className="md:hidden">
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-50 bg-black/50"
            onClick={handleClose}
          />
          {/* Sheet */}
          <div
            className={cn(
              "fixed bottom-0 left-0 right-0 z-50 bg-background rounded-t-2xl border-t border-border shadow-2xl",
              "animate-in slide-in-from-bottom-2 duration-200",
            )}
          >
            {/* Drag handle */}
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 rounded-full bg-border" />
            </div>
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-border">
              <span className="text-sm font-semibold">Add Worktree</span>
              <button
                onClick={handleClose}
                className="flex items-center justify-center size-7 rounded-md hover:bg-surface-elevated transition-colors"
              >
                <X className="size-4" />
              </button>
            </div>
            {/* Body */}
            <div className="px-4 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
              {formContent}
              {footer}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
