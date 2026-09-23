import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Group, Panel, Separator, type Layout } from "react-resizable-panels";
import {
  clampChatPercent, loadDesignViewPrefs, saveDesignViewPrefs, withChatPercent,
} from "@/lib/design/design-view-prefs";

const CHAT_PANEL_ID = "design-chat";

/**
 * Desktop: chat on the left, canvas on the right, split by a draggable handle whose position
 * is remembered per device.
 *
 * While the handle is dragged the iframe must not see the pointer — an iframe swallows the
 * `pointermove`s the split listens for, and the handle drops out from under the cursor. The
 * root carries `data-design-resizing` for that long, and the canvas turns pointer events off
 * under it.
 */
export function DesignSplitLayout({ chat, canvas }: { chat: ReactNode; canvas: ReactNode }) {
  const [chatPercent] = useState(() => loadDesignViewPrefs().chatPercent);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    if (!resizing) return;
    const stop = () => setResizing(false);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [resizing]);

  const onPointerDownCapture = useCallback((e: React.PointerEvent) => {
    if ((e.target as Element | null)?.closest?.("[data-separator]")) setResizing(true);
  }, []);

  const onLayoutChanged = useCallback((layout: Layout) => {
    const pct = layout[CHAT_PANEL_ID];
    if (typeof pct === "number") saveDesignViewPrefs(withChatPercent(loadDesignViewPrefs(), pct));
  }, []);

  return (
    <div className="h-full" data-design-resizing={resizing ? "" : undefined} onPointerDownCapture={onPointerDownCapture}>
      <Group orientation="horizontal" onLayoutChanged={onLayoutChanged} style={{ height: "100%" }}>
        {/* Sizes are percentage strings: bare numbers mean pixels in this library. */}
        <Panel id={CHAT_PANEL_ID} defaultSize={`${clampChatPercent(chatPercent)}%`} minSize="20%" maxSize="70%">
          <div className="h-full min-w-0 border-r border-border">{chat}</div>
        </Panel>
        <Separator className="w-1 cursor-col-resize bg-border/30 transition-colors hover:bg-primary/30 active:bg-primary/50" />
        <Panel minSize="25%">
          {canvas}
        </Panel>
      </Group>
    </div>
  );
}
