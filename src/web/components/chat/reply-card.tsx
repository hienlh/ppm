import { useState } from "react";
import type { ReplyReference } from "../../../shared/chat-reply";
import { XCircle } from "@/lib/icons";

/** Snapshot stays readable even when the original has been compacted or unloaded. */
export function ReplyCard({ reply, onJump, unavailable, onCancel, preview }: {
  reply: ReplyReference;
  onJump?: () => void;
  unavailable?: boolean;
  onCancel?: () => void;
  preview?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="mb-2 min-w-0 rounded-md border border-border border-l-2 border-l-primary bg-surface/60 px-2 py-1 text-xs text-text-secondary">
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={onJump} disabled={!onJump} className="min-h-[44px] md:min-h-0 text-left font-medium text-primary disabled:text-text-secondary">
          {preview ? "Replying to " : "Reply to "}{reply.role === "user" ? "you" : "AI"}
        </button>
        {onCancel && <button type="button" onClick={onCancel} aria-label="Cancel reply" title="Cancel reply" className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded hover:bg-surface-hover"><XCircle className="size-4" /></button>}
      </div>
      <p className={`whitespace-pre-wrap break-words select-text ${expanded ? "max-h-60 overflow-y-auto" : "line-clamp-2"}`}>{reply.quote}</p>
      {reply.truncated && <p className="mt-1 text-text-subtle">Quote shortened to 12,000 characters</p>}
      {unavailable && <p className="mt-1 text-text-subtle">Original message unavailable</p>}
      <button type="button" onClick={() => setExpanded(!expanded)} className="min-h-[44px] md:min-h-0 text-primary hover:underline">{expanded ? "Show less" : "Show quote"}</button>
    </div>
  );
}
