import { X, FileText, Image as ImageIcon, Loader2 } from "lucide-react";
import type { ChatAttachment } from "./message-input";

interface AttachmentChipsProps {
  attachments: ChatAttachment[];
  onRemove: (id: string) => void;
}

export function AttachmentChips({ attachments, onRemove }: AttachmentChipsProps) {
  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 px-2 md:px-4 pt-2">
      {attachments.map((att) => (
        <div
          key={att.id}
          className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-secondary max-w-48"
        >
          {/* Thumbnail or icon */}
          {att.previewUrl ? (
            <img
              src={att.previewUrl}
              alt={att.name}
              className="size-5 rounded object-cover shrink-0"
            />
          ) : att.isImage ? (
            <ImageIcon className="size-3.5 shrink-0 text-text-subtle" />
          ) : (
            <FileText className="size-3.5 shrink-0 text-text-subtle" />
          )}

          {/* File name */}
          <span className="truncate">{att.name}</span>

          {/* Status indicator */}
          {att.status === "uploading" ? (
            <Loader2 className="size-3 shrink-0 animate-spin text-text-subtle" />
          ) : att.status === "error" ? (
            <span className="text-red-500 shrink-0" title="Upload failed">!</span>
          ) : null}

          {/* Remove button */}
          <button
            type="button"
            onClick={() => onRemove(att.id)}
            className="shrink-0 rounded-sm p-0.5 hover:bg-border/50 transition-colors"
            aria-label={`Remove ${att.name}`}
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
