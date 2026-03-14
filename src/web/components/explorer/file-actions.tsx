import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { api } from "../../lib/api-client";

type FileActionType = "new-file" | "new-folder" | "rename" | "delete" | null;

interface FileActionsProps {
  action: FileActionType;
  targetPath: string;
  targetName?: string;
  onClose: () => void;
  onDone: () => void;
}

export function FileActions({ action, targetPath, targetName, onClose, onDone }: FileActionsProps) {
  const [inputValue, setInputValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (action === "rename") {
      setInputValue(targetName ?? "");
    } else {
      setInputValue("");
    }
    setError(null);
  }, [action, targetName]);

  const open = action !== null;

  const getTitle = () => {
    switch (action) {
      case "new-file": return "New File";
      case "new-folder": return "New Folder";
      case "rename": return "Rename";
      case "delete": return `Delete "${targetName}"?`;
      default: return "";
    }
  };

  const handleConfirm = async () => {
    setLoading(true);
    setError(null);
    try {
      if (action === "new-file") {
        const dir = targetPath.endsWith("/") ? targetPath : `${targetPath}/`;
        await api.post("/api/files/create", { path: `${dir}${inputValue}`, type: "file" });
      } else if (action === "new-folder") {
        const dir = targetPath.endsWith("/") ? targetPath : `${targetPath}/`;
        await api.post("/api/files/create", { path: `${dir}${inputValue}`, type: "directory" });
      } else if (action === "rename") {
        const parent = targetPath.substring(0, targetPath.lastIndexOf("/") + 1);
        await api.post("/api/files/rename", { oldPath: targetPath, newPath: `${parent}${inputValue}` });
      } else if (action === "delete") {
        await api.delete(`/api/files/delete?path=${encodeURIComponent(targetPath)}`);
      }
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Operation failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{getTitle()}</DialogTitle>
        </DialogHeader>

        {action === "delete" ? (
          <p className="text-sm text-muted-foreground">
            This action cannot be undone.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <Input
              autoFocus
              placeholder="Name"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && inputValue.trim()) handleConfirm();
              }}
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant={action === "delete" ? "destructive" : "default"}
            onClick={handleConfirm}
            disabled={loading || (action !== "delete" && !inputValue.trim())}
          >
            {action === "delete" ? "Delete" : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
