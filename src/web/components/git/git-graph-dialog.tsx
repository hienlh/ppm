import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface GitGraphDialogProps {
  type: "branch" | "tag" | null;
  hash?: string;
  onClose: () => void;
  onCreateBranch: (name: string, from: string) => void;
  onCreateTag: (name: string, hash?: string) => void;
}

export function GitGraphDialog({
  type,
  hash,
  onClose,
  onCreateBranch,
  onCreateTag,
}: GitGraphDialogProps) {
  const [inputValue, setInputValue] = useState("");

  const handleSubmit = () => {
    if (!inputValue.trim()) return;
    if (type === "branch") {
      onCreateBranch(inputValue.trim(), hash!);
    } else {
      onCreateTag(inputValue.trim(), hash);
    }
    onClose();
  };

  return (
    <Dialog
      open={type !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {type === "branch" ? "Create Branch" : "Create Tag"}
          </DialogTitle>
        </DialogHeader>
        <Input
          placeholder={type === "branch" ? "Branch name" : "Tag name"}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
          }}
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!inputValue.trim()} onClick={handleSubmit}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
