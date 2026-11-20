/**
 * The comment under a line: a box to write it in, or the saved text with Edit and Delete. Shared
 * by the Review tab's diff and the plan card. Enter saves, Shift+Enter breaks the line, Escape
 * cancels.
 */
import { useState } from "react";
import { MessageCircle, Pencil, Trash2 } from "@/lib/icons";
import { cn } from "@/lib/utils";

const BTN = "inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-xs font-medium transition-colors max-md:h-[26px]";

export function LineCommentBox({ body, editing, onEdit, onSave, onCancel, onDelete, className }: {
  body: string;
  editing: boolean;
  onEdit: () => void;
  onSave: (body: string) => void;
  onCancel: () => void;
  onDelete: () => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(body);
  if (!editing) {
    return (
      <div data-line-comment="" className={cn("flex items-start gap-2 rounded-md border border-border-soft bg-panel px-2.5 py-1.5 font-sans text-xs text-text", className)}>
        <MessageCircle className="mt-0.5 size-3.5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{body}</span>
        <button type="button" onClick={onEdit} aria-label="Edit comment" title="Edit comment" className="grid size-6 shrink-0 place-items-center rounded text-text-3 can-hover:hover:bg-surface-hover can-hover:hover:text-text">
          <Pencil className="size-3.5" />
        </button>
        <button type="button" onClick={onDelete} aria-label="Delete comment" title="Delete comment" className="grid size-6 shrink-0 place-items-center rounded text-text-3 can-hover:hover:bg-surface-hover can-hover:hover:text-error">
          <Trash2 className="size-3.5" />
        </button>
      </div>
    );
  }
  return (
    <div data-line-comment-editor="" className={cn("space-y-1.5 rounded-md border border-primary/50 bg-panel p-2 font-sans", className)}>
      <textarea
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); onSave(draft); }
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); }
        }}
        rows={2}
        placeholder="Comment on this line"
        aria-label="Comment on this line"
        className="w-full resize-y rounded border border-border bg-background p-2 text-xs text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-primary"
      />
      <div className="flex gap-1.5">
        <button type="button" onClick={() => onSave(draft)} disabled={!draft.trim()} className={cn(BTN, "bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50")}>
          Comment
        </button>
        <button type="button" onClick={onCancel} className={cn(BTN, "border border-border text-text-2 hover:text-text")}>Cancel</button>
      </div>
    </div>
  );
}
