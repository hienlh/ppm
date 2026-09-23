import { useState } from "react";
import { CheckCircle, ChevronDown, ChevronRight, Loader2, MessageSquarePlus, RotateCcw, Send, Trash2, X } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from "@/components/ui/adaptive-context-menu";
import { formatRelativeDate } from "@/lib/format-date";
import type { DesignCommentsState } from "./use-design-comments";
import type { PinStatus } from "./use-comment-pins";
import type { DesignComment } from "../../../../shared/design-comment-types";

/**
 * The design's comments as a list: open ones numbered like their pins, resolved ones
 * folded below, and the one action that gathers them all for the AI. Rows use the adaptive
 * context menu; a tap opens the comment. A comment whose element could not be found is
 * marked Detached rather than hidden — it still says what the user wanted changed.
 */

export interface CommentsPanelActions {
  onOpen: (c: DesignComment) => void;
  onResolve: (c: DesignComment, resolved: boolean) => void;
  onSend: (c: DesignComment) => void;
  onDelete: (c: DesignComment) => void;
  onSendAll: () => void;
  onClose: () => void;
}

const STATUS_LABEL: Partial<Record<PinStatus, string>> = { detached: "Detached", moved: "Moved", elsewhere: "On another page" };

function Row({ c, number, status, actions }: {
  c: DesignComment;
  number: number | null;
  status: PinStatus | null;
  actions: CommentsPanelActions;
}) {
  const label = status ? STATUS_LABEL[status] : undefined;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button type="button" onClick={() => actions.onOpen(c)}
          className="flex min-h-11 w-full select-none items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-elevated">
          <span className={number === null
            ? "mt-0.5 flex size-5 shrink-0 items-center justify-center text-text-subtle"
            : "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground"}>
            {number ?? <CheckCircle className="size-4" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 text-sm">{c.body}</span>
            <span className="block truncate text-xs text-text-subtle">
              &lt;{c.anchor.tag}&gt; · {status === "elsewhere" ? c.file : formatRelativeDate(c.createdAt)}
              {label && <> · <span className={status === "detached" ? "text-warning" : undefined}>{label}</span></>}
              {c.sentAt && " · Sent"}
            </span>
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {c.resolvedAt
          ? <ContextMenuItem onClick={() => actions.onResolve(c, false)}><RotateCcw className="size-4" /> Reopen</ContextMenuItem>
          : <ContextMenuItem onClick={() => actions.onResolve(c, true)}><CheckCircle className="size-4" /> Resolve</ContextMenuItem>}
        <ContextMenuItem onClick={() => actions.onSend(c)}><Send className="size-4" /> Send to AI</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => actions.onDelete(c)}><Trash2 className="size-4" /> Delete</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function CommentsPanel({ state, statusOf, actions }: {
  state: DesignCommentsState;
  statusOf: (id: string) => PinStatus;
  actions: CommentsPanelActions;
}) {
  const [showResolved, setShowResolved] = useState(false);
  const { open, resolved, comments, error } = state;
  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
        <MessageSquarePlus className="size-4 text-text-subtle" />
        <span className="flex-1 text-xs font-semibold">Comments</span>
        <button type="button" onClick={actions.onClose} aria-label="Close comments"
          className="flex size-11 items-center justify-center rounded-md text-text-subtle hover:bg-surface-elevated md:size-7">
          <X className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {error ? (
          <div className="p-3 text-xs text-destructive">
            {error} <button type="button" className="min-h-11 px-1 text-primary underline md:min-h-0" onClick={state.reload}>Retry</button>
          </div>
        ) : comments === null ? (
          <div className="flex justify-center py-6"><Loader2 className="size-4 animate-spin text-primary" /></div>
        ) : open.length === 0 && resolved.length === 0 ? (
          <p className="p-3 text-xs leading-relaxed text-text-subtle">
            No comments yet. Turn on Select, pick an element on the canvas and leave a note on it; then send the notes to the AI together.
          </p>
        ) : (
          <>
            {open.map((c, i) => <Row key={c.id} c={c} number={i + 1} status={statusOf(c.id)} actions={actions} />)}
            {open.length === 0 && <p className="p-3 text-xs text-text-subtle">Every comment is resolved.</p>}
            {resolved.length > 0 && (
              <button type="button" onClick={() => setShowResolved((v) => !v)} aria-expanded={showResolved}
                className="mt-1 flex min-h-11 w-full items-center gap-1 px-2 text-xs font-semibold text-text-subtle md:min-h-8">
                {showResolved ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />} Resolved ({resolved.length})
              </button>
            )}
            {showResolved && resolved.map((c) => <Row key={c.id} c={c} number={null} status={null} actions={actions} />)}
          </>
        )}
      </div>
      <div className="shrink-0 border-t border-border p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <Button className="min-h-11 w-full md:min-h-9" disabled={open.length === 0} onClick={actions.onSendAll}>
          <Send className="size-4" /> {open.length === 1 ? "Send 1 open comment to AI" : `Send ${open.length} open comments to AI`}
        </Button>
      </div>
    </div>
  );
}
