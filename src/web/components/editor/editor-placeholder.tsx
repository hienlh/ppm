import { FileCode } from "lucide-react";

export function EditorPlaceholder() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary">
      <FileCode className="size-10 text-text-subtle" />
      <p className="text-sm">Code Editor — coming in Phase 4</p>
    </div>
  );
}
