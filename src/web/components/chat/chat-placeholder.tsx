import { MessageSquare } from "lucide-react";

export function ChatPlaceholder() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary">
      <MessageSquare className="size-10 text-text-subtle" />
      <p className="text-sm">AI Chat — coming in Phase 7</p>
    </div>
  );
}
