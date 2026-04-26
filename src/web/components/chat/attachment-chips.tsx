import { useState } from "react";
import { X, FileText, Image as ImageIcon, Loader2, TerminalSquare, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatAttachment } from "./message-input";

interface AttachmentChipsProps {
  attachments: ChatAttachment[];
  onRemove: (id: string) => void;
}

export function AttachmentChips({ attachments, onRemove }: AttachmentChipsProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (attachments.length === 0) return null;

  const expanded = expandedId ? attachments.find((a) => a.id === expandedId) : null;

  return (
    <div className="px-2 md:px-4 pt-2">
      <div className="flex flex-wrap gap-1.5">
        {attachments.map((att) => (
          <div
            key={att.id}
            className={cn(
              "flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-secondary max-w-48",
              att.textContent && "cursor-pointer hover:border-primary/50",
              expandedId === att.id && "border-primary/50 bg-surface-elevated",
            )}
            onClick={() => {
              if (att.textContent) setExpandedId(expandedId === att.id ? null : att.id);
            }}
          >
            {/* Thumbnail or icon */}
            {att.previewUrl ? (
              <img src={att.previewUrl} alt={att.name} className="size-5 rounded object-cover shrink-0" />
            ) : att.textContent ? (
              <TerminalSquare className="size-3.5 shrink-0 text-text-subtle" />
            ) : att.isImage ? (
              <ImageIcon className="size-3.5 shrink-0 text-text-subtle" />
            ) : (
              <FileText className="size-3.5 shrink-0 text-text-subtle" />
            )}

            <span className="truncate">{att.name}</span>

            {/* Expand indicator for text attachments */}
            {att.textContent && (
              <ChevronDown className={cn("size-3 shrink-0 text-text-subtle transition-transform", expandedId === att.id && "rotate-180")} />
            )}

            {att.status === "uploading" ? (
              <Loader2 className="size-3 shrink-0 animate-spin text-text-subtle" />
            ) : att.status === "error" ? (
              <span className="text-red-500 shrink-0" title="Upload failed">!</span>
            ) : null}

            {/* Remove button */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRemove(att.id); if (expandedId === att.id) setExpandedId(null); }}
              className="shrink-0 rounded-sm p-0.5 hover:bg-border/50 transition-colors"
              aria-label={`Remove ${att.name}`}
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
      </div>

      {/* Expanded preview for text attachment */}
      {expanded?.textContent && (
        <pre className="mt-1.5 max-h-40 overflow-auto rounded-md border border-border bg-background p-2 text-xs text-text-primary font-mono whitespace-pre-wrap break-words">
          {stripCodeFence(expanded.textContent)}
        </pre>
      )}
    </div>
  );
}

/** Strip markdown code fence wrapper for preview display */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```\w*\n([\s\S]*?)\n```$/);
  return match ? match[1]! : trimmed;
}
