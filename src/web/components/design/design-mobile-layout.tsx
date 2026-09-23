import { useState, type ReactNode } from "react";
import { MessageSquare, MoreHorizontal, Palette } from "@/lib/icons";
import { cn } from "@/lib/utils";

export type DesignMobilePane = "canvas" | "chat";

/**
 * Phone: the canvas full width, with a thumb-zone bar to switch to the chat and to open the
 * canvas's More sheet.
 *
 * Both panes stay mounted and the hidden one is only `display: none`. Unmounting the chat
 * would drop its socket (and any message still waiting for it), and unmounting the canvas
 * would reload the design every time the user glanced at the conversation.
 */
export function DesignMobileLayout({ pane, onPaneChange, chat, canvas }: {
  pane: DesignMobilePane;
  onPaneChange: (pane: DesignMobilePane) => void;
  chat: ReactNode;
  canvas: (more: { open: boolean; onClose: () => void }) => ReactNode;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const tabBtn = (active: boolean) => cn(
    "flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-md text-[11px] font-medium",
    active ? "text-primary" : "text-text-subtle",
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn("min-h-0 flex-1", pane !== "canvas" && "hidden")}>
        {canvas({ open: moreOpen, onClose: () => setMoreOpen(false) })}
      </div>
      <div className={cn("min-h-0 flex-1", pane !== "chat" && "hidden")}>{chat}</div>
      <nav aria-label="Design view" className="flex shrink-0 gap-2 border-t border-border bg-panel px-2 py-1 pb-[max(0.25rem,env(safe-area-inset-bottom))]">
        <button type="button" className={tabBtn(pane === "canvas")} aria-pressed={pane === "canvas"} onClick={() => onPaneChange("canvas")}>
          <Palette className="size-5" /> Canvas
        </button>
        <button type="button" className={tabBtn(pane === "chat")} aria-pressed={pane === "chat"} onClick={() => onPaneChange("chat")}>
          <MessageSquare className="size-5" /> Chat
        </button>
        <button type="button" className={tabBtn(false)} aria-haspopup="dialog" onClick={() => { onPaneChange("canvas"); setMoreOpen(true); }}>
          <MoreHorizontal className="size-5" /> More
        </button>
      </nav>
    </div>
  );
}
