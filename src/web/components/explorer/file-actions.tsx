import { useState, useEffect, useRef } from "react";
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
import { Input } from "@/components/ui/input";

interface FileActionsProps {
  action: string;
  node: FileNode;
  projectName: string;
  onClose: () => void;
  onRefresh: () => void;
}

export function FileActions({
  action,
  node,
  projectName,
  onClose,
  onRefresh,
}: FileActionsProps) {
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (action === "rename") {
      setName(node.name);
    } else {
      setName("");
    }
  }, [action, node.name]);

  useEffect(() => {
    // Focus input after dialog mounts
    const timer = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, []);

  async function handleCreate(type: "file" | "directory") {
    if (!name.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const parentPath = node.type === "directory" ? node.path : node.path.split("/").slice(0, -1).join("/");
      const fullPath = parentPath ? `${parentPath}/${name.trim()}` : name.trim();
      await api.post(`${projectUrl(projectName)}/files/create`, {
        path: fullPath,
        type,
      });
      onRefresh();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setLoading(false);
    }
  }

  async function handleRename() {
    if (!name.trim() || name.trim() === node.name) {
      onClose();
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const parentPath = node.path.split("/").slice(0, -1).join("/");
      const newPath = parentPath ? `${parentPath}/${name.trim()}` : name.trim();
      await api.post(`${projectUrl(projectName)}/files/rename`, {
        oldPath: node.path,
        newPath,
      });
      onRefresh();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename");
    } finally {
      setLoading(false);
    }
  }

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

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      if (action === "new-file") handleCreate("file");
      else if (action === "new-folder") handleCreate("directory");
      else if (action === "rename") handleRename();
    }
    if (e.key === "Escape") onClose();
  }

  if (action === "delete") {
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

  const title =
    action === "new-file"
      ? "New File"
      : action === "new-folder"
        ? "New Folder"
        : "Rename";

  const placeholder =
    action === "rename" ? node.name : action === "new-file" ? "filename.ts" : "folder-name";

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {action === "rename"
              ? `Rename "${node.name}" to:`
              : `Create in ${node.type === "directory" ? node.path || "/" : node.path.split("/").slice(0, -1).join("/") || "/"}`}
          </DialogDescription>
        </DialogHeader>
        <Input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={loading}
        />
        {error && <p className="text-sm text-error">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (action === "new-file") handleCreate("file");
              else if (action === "new-folder") handleCreate("directory");
              else handleRename();
            }}
            disabled={loading || !name.trim()}
          >
            {loading ? "Saving..." : action === "rename" ? "Rename" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
