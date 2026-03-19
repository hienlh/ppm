import { useState } from "react";
import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FileBrowserPicker, type FileBrowserPickerProps } from "./file-browser-picker";
import { cn } from "@/lib/utils";

interface BrowseButtonProps {
  mode: FileBrowserPickerProps["mode"];
  accept?: string[];
  root?: string;
  title?: string;
  onSelect: (path: string) => void;
  className?: string;
}

export function BrowseButton({ mode, accept, root, title, onSelect, className }: BrowseButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn("size-8 shrink-0", className)}
        onClick={() => setOpen(true)}
        title={title ?? "Browse..."}
      >
        <FolderOpen className="size-4" />
      </Button>
      <FileBrowserPicker
        open={open}
        mode={mode}
        accept={accept}
        root={root}
        title={title}
        onSelect={(path) => { onSelect(path); setOpen(false); }}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}
