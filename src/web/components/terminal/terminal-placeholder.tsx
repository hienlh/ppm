import { Terminal } from "lucide-react";

export function TerminalPlaceholder() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary">
      <Terminal className="size-10 text-text-subtle" />
      <p className="text-sm">Terminal — coming in Phase 5</p>
    </div>
  );
}
