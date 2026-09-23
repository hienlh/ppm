import { CheckCircle, Send, Trash2 } from "@/lib/icons";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from "@/components/ui/adaptive-context-menu";
import { cn } from "@/lib/utils";
import type { FrameFit, Size } from "../canvas/canvas-geometry";
import type { CommentPins } from "./use-comment-pins";
import { pinCenter, rectVisible } from "./comment-overlay-geometry";
import type { DesignComment } from "../../../../shared/design-comment-types";

/**
 * Numbered pins over the canvas, one per open comment whose element is on screen, at the
 * element's top-right corner. Each is a 44px target (the dot inside is smaller) with the
 * adaptive context menu: right-click on desktop, long-press on touch; a tap opens the
 * comment. A pin that was found again by its text after an edit gets a dashed ring, so a
 * re-anchor is visible rather than silent.
 */

export interface PinActions {
  onOpen: (c: DesignComment) => void;
  onResolve: (c: DesignComment) => void;
  onSend: (c: DesignComment) => void;
  onDelete: (c: DesignComment) => void;
}

export function CommentPinsOverlay({ open, pins, fit, stage, actions }: {
  open: readonly DesignComment[];
  pins: CommentPins;
  fit: FrameFit;
  stage: Size;
  actions: PinActions;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden" aria-label="Comment pins">
      {open.map((c, i) => {
        const status = pins.statusOf(c.id);
        const rect = pins.rects.get(c.id)?.rect;
        if ((status !== "pinned" && status !== "moved") || !rect || !rectVisible(rect, fit)) return null;
        const at = pinCenter(rect, fit, stage);
        return (
          <ContextMenu key={c.id}>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                onClick={() => actions.onOpen(c)}
                aria-label={`Comment ${i + 1}: ${c.body}`}
                title={c.body}
                className="pointer-events-auto absolute flex size-11 -translate-x-1/2 -translate-y-1/2 select-none items-center justify-center"
                style={{ left: at.left, top: at.top }}
              >
                <span className={cn(
                  "flex size-6 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground shadow-md ring-2 ring-background",
                  status === "moved" && "outline-dashed outline-2 outline-offset-2 outline-primary",
                )}>
                  {i + 1}
                </span>
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => actions.onResolve(c)}><CheckCircle className="size-4" /> Resolve</ContextMenuItem>
              <ContextMenuItem onClick={() => actions.onSend(c)}><Send className="size-4" /> Send to AI</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onClick={() => actions.onDelete(c)}><Trash2 className="size-4" /> Delete</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </div>
  );
}
