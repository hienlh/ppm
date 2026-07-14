import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface DeleteResourceDialogProps {
  open: boolean;
  /** e.g. "skill", "agent", "command", "MCP server" */
  kind: string;
  name: string;
  /** Show the "and its entire folder" warning (skills are dir-based). */
  folderWarning?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteResourceDialog({ open, kind, name, folderWarning, onCancel, onConfirm }: DeleteResourceDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {kind}?</DialogTitle>
          <DialogDescription>
            This permanently deletes <span className="font-medium text-foreground">{name}</span>
            {folderWarning ? " and its entire skill folder" : ""}. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="destructive" onClick={onConfirm}>Delete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
