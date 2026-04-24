/**
 * FileActions — delete confirmation dialog.
 * Create and rename are handled inline by InlineTreeInput.
 */
import { useState } from "react";
import { api, projectUrl } from "@/lib/api-client";
import type { FileNode } from "@/stores/file-store";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface FileActionsProps {
  action: "delete";
  node: FileNode;
  projectName: string;
  onClose: () => void;
  onRefresh: () => void;
}

export function FileActions({
  node,
  projectName,
  onClose,
  onRefresh,
}: FileActionsProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setLoading(true);
    setError(null);
    try {
      await api.del(`${projectUrl(projectName)}/files/delete`, {
        path: node.path,
      });
      onRefresh();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {node.type === "directory" ? "Folder" : "File"}</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete{" "}
            <span className="font-mono font-semibold">{node.name}</span>?
            {node.type === "directory" && " This will delete all contents."}
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-error">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={loading}>
            {loading ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
