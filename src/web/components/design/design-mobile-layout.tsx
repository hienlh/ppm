import { MessageSquare, MoreHorizontal, Palette } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { DesignPane } from "@/lib/design/design-layout-mode";

/**
 * Phone: the thumb-zone bar under the single pane — switch to the canvas or the chat, or
 * open the canvas's More sheet.
 *
 * Only the bar lives here. The panes themselves are laid out by `DesignTabLayout`, the same
 * tree a desktop uses, so crossing the phone breakpoint never remounts the chat or the canvas.
 */
export function DesignMobilePaneBar({ pane, onPaneChange, onMore }: {
  pane: DesignPane;
  onPaneChange: (pane: DesignPane) => void;
  onMore: () => void;
}) {
  const tabBtn = (active: boolean) => cn(
    "flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-md text-[11px] font-medium",
    active ? "text-primary" : "text-text-subtle",
  );
  return (
    <nav aria-label="Design view" className="flex shrink-0 gap-2 border-t border-border bg-panel px-2 py-1 pb-[max(0.25rem,env(safe-area-inset-bottom))]">
      <button type="button" className={tabBtn(pane === "canvas")} aria-pressed={pane === "canvas"} onClick={() => onPaneChange("canvas")}>
        <Palette className="size-5" /> Canvas
      </button>
      <button type="button" className={tabBtn(pane === "chat")} aria-pressed={pane === "chat"} onClick={() => onPaneChange("chat")}>
        <MessageSquare className="size-5" /> Chat
      </button>
      <button type="button" className={tabBtn(false)} aria-haspopup="dialog" onClick={onMore}>
        <MoreHorizontal className="size-5" /> More
      </button>
    </nav>
  );
}
