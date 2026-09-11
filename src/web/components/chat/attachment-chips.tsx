import { useEffect, useRef, useState } from "react";
import { X, FileText, Image as ImageIcon, Loader2, TerminalSquare, ChevronDown } from "@/lib/icons";
import { useImageOverlay } from "@/stores/image-overlay-store";
import { collectGallery, GALLERY_ITEM_ATTR, GALLERY_ROOT_ATTR } from "@/lib/image-gallery";
import { usePrefersCoarsePointer } from "@/components/os-explorer/use-coarse-long-press";
import { cn } from "@/lib/utils";
import type { ChatAttachment } from "./message-input";

interface AttachmentChipsProps {
  attachments: ChatAttachment[];
  onRemove: (id: string) => void;
}

export function AttachmentChips({ attachments, onRemove }: AttachmentChipsProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const coarse = usePrefersCoarsePointer();

  // Every preview URL this component has handed to the lightbox, mapped back to the
  // attachment it belongs to. Keyed by URL rather than tracking one "currently
  // viewing" id, because the arrow keys move the viewer between attachments and a
  // single remembered id stops describing what is on screen the moment they are used.
  const owned = useRef(new Map<string, string>());
  const openOverlay = useImageOverlay((s) => s.open);
  const closeOverlay = useImageOverlay((s) => s.close);
  const overlaySrc = useImageOverlay((s) => s.src);

  /**
   * A preview URL is not stable for the life of the attachment, so an open lightbox has
   * to follow it. `processFiles` creates one from the file as pasted, then downscales,
   * then revokes the first and points the chip at the reduced copy — and clicking the
   * thumbnail the moment a screenshot is pasted lands inside exactly that window.
   * Removing the attachment, or sending the message, revokes it outright.
   *
   * A revoked blob URL does not raise anything. It renders as a broken image inside the
   * viewer, with nothing to say why, so the two cases are handled apart: a URL that was
   * replaced is followed, and one whose attachment is gone closes the viewer.
   */
  useEffect(() => {
    if (!overlaySrc) return;
    const id = owned.current.get(overlaySrc);
    if (!id) return; // Showing something else entirely — a transcript image.
    const att = attachments.find((a) => a.id === id);
    if (!att?.previewUrl) return closeOverlay();
    if (att.previewUrl !== overlaySrc) {
      owned.current.set(att.previewUrl, att.id);
      openOverlay(att.previewUrl, att.name);
    }
  }, [attachments, overlaySrc, openOverlay, closeOverlay]);

  if (attachments.length === 0) return null;

  const expanded = expandedId ? attachments.find((a) => a.id === expandedId) : null;

  function preview(att: ChatAttachment, target: Element) {
    if (!att.previewUrl) return;
    // The gallery is every other image waiting in the composer, so a batch of pasted
    // screenshots is walked with the arrow keys instead of closed and reopened one at a
    // time. Every one of them is claimed, not just the one clicked, because any of them
    // can become the image on screen without this component hearing about it.
    for (const a of attachments) if (a.previewUrl) owned.current.set(a.previewUrl, a.id);
    openOverlay(att.previewUrl, att.name, collectGallery(target));
  }

  return (
    <div className="px-2 md:px-4 pt-2">
      <div className="flex flex-wrap gap-1.5" {...{ [GALLERY_ROOT_ATTR]: "" }}>
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
              // A real button, not a click handler on the chip: the chip already carries the
              // remove button, and a button inside a button is invalid. It also means the
              // preview is reachable by keyboard, which the chip never was.
              //
              // The visible thumbnail stays 20px and only the tap-registering area grows to
              // the 44px minimum, through the same invisible `::before` the explorer toolbar
              // uses — a chip that changed size on a phone would push the composer around.
              <button
                type="button"
                title={`Preview ${att.name}`}
                aria-label={`Preview ${att.name}`}
                onClick={(e) => { e.stopPropagation(); preview(att, e.currentTarget); }}
                className={cn(
                  "relative shrink-0 rounded",
                  "can-hover:hover:ring-2 can-hover:hover:ring-primary/60 transition-shadow",
                  coarse && "before:absolute before:-inset-3 before:content-['']",
                )}
              >
                <img
                  src={att.previewUrl}
                  alt={att.name}
                  {...{ [GALLERY_ITEM_ATTR]: "" }}
                  className="size-5 rounded object-cover"
                />
              </button>
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
              <span className="text-error shrink-0" title="Upload failed">!</span>
            ) : att.resized ? (
              // Says what happened to the image. A screenshot arriving at the model smaller
              // than the one that was pasted is worth stating rather than leaving to be
              // discovered, and the measurement was already being recorded for nothing.
              <span
                className="shrink-0 text-[10px] text-text-subtle"
                title={`Shrunk from ${att.resized.from.width}x${att.resized.from.height} to ${att.resized.to.width}x${att.resized.to.height}`}
              >
                {att.resized.to.width}&times;{att.resized.to.height}
              </span>
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
