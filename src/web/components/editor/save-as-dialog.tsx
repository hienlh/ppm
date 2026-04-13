import { useState, useCallback } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FileBrowserPicker } from "@/components/ui/file-browser-picker";
import { useProjectStore } from "@/stores/project-store";

interface SaveAsDialogProps {
  open: boolean;
  defaultName: string;
  content: string;
  onSave: (fullPath: string, content: string) => void;
  onCancel: () => void;
}

export function SaveAsDialog({ open, defaultName, content, onSave, onCancel }: SaveAsDialogProps) {
  const [filename, setFilename] = useState(defaultName);
  const [showPicker, setShowPicker] = useState(false);
  const [error, setError] = useState("");
  const activeProject = useProjectStore((s) => s.activeProject);

  const validateAndProceed = useCallback(() => {
    const trimmed = filename.trim();
    if (!trimmed) { setError("Filename cannot be empty"); return; }
    if (/[/\\]/.test(trimmed)) { setError("Filename cannot contain / or \\"); return; }
    setError("");
    setShowPicker(true);
  }, [filename]);

  const handleFolderSelect = useCallback((dirPath: string) => {
    const sep = dirPath.includes("\\") ? "\\" : "/";
    const fullPath = dirPath.endsWith(sep) ? `${dirPath}${filename.trim()}` : `${dirPath}${sep}${filename.trim()}`;
    onSave(fullPath, content);
  }, [filename, content, onSave]);

  if (showPicker) {
    return (
      <FileBrowserPicker
        open
        mode="folder"
        root={activeProject?.path}
        title={`Save "${filename.trim()}" to...`}
        onSelect={handleFolderSelect}
        onCancel={() => setShowPicker(false)}
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save As</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2 py-2">
          <label className="text-sm text-muted-foreground">Filename</label>
          <Input
            value={filename}
            onChange={(e) => { setFilename(e.target.value); setError(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") validateAndProceed(); }}
            placeholder="e.g. my-file.ts"
            autoFocus
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button onClick={validateAndProceed}>Choose Folder...</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
