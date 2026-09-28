import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Group, Panel, Separator, type Layout } from "react-resizable-panels";
import { cn } from "@/lib/utils";
import {
  clampChatPercent, loadDesignViewPrefs, saveDesignViewPrefs, withChatPercent,
} from "@/lib/design/design-view-prefs";
import type { DesignLayoutControls } from "./design-tab-context";
import { DesignChatPaneHeader } from "./design-layout-controls";
import { DesignMobilePaneBar } from "./design-mobile-layout";

const CHAT_PANEL_ID = "design-chat";

/**
 * The design tab's one layout tree, for every width: chat and canvas side by side in a
 * resizable group, or one of them alone, with the phone's bar under it on a phone.
 *
 * Nothing here is ever mounted conditionally around the two panes. Moving an iframe in the
 * DOM reloads the design and unmounting the chat drops its socket (and any message still
 * waiting for it), so a change of layout only changes classes: the pane not shown is
 * `display: none`, which the library's panel wrapper can only be given through a descendant
 * rule, because its inline `display: flex` takes no class. The group is disabled while one
 * pane shows, which also takes the hidden separator out of the library's hit testing.
 *
 * While the handle is dragged the iframe must not see the pointer — an iframe swallows the
 * `pointermove`s the split listens for, and the handle drops out from under the cursor. The
 * root carries `data-design-resizing` for that long, and the canvas turns pointer events off
 * under it.
 */
export function DesignTabLayout({ rootRef, layout, chat, canvas }: {
  rootRef: RefObject<HTMLDivElement | null>;
  layout: DesignLayoutControls;
  chat: ReactNode;
  canvas: (more: { open: boolean; onClose: () => void }) => ReactNode;
}) {
  const [chatPercent] = useState(() => loadDesignViewPrefs().chatPercent);
  const [resizing, setResizing] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // Read by the layout callback, which must not record a share while a pane is hidden.
  const splitRef = useRef(layout.split);
  splitRef.current = layout.split;

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
    if (splitRef.current && (e.target as Element | null)?.closest?.("[data-separator]")) setResizing(true);
  }, []);

  const onLayoutChanged = useCallback((next: Layout) => {
    const pct = next[CHAT_PANEL_ID];
    if (splitRef.current && typeof pct === "number") saveDesignViewPrefs(withChatPercent(loadDesignViewPrefs(), pct));
  }, []);

  const { split, pane } = layout;
  // One pane shows no separator, so the library's hold on touch gestures (`pan-y` for a
  // horizontal group) would only stop a design from scrolling sideways under a finger.
  const panelTouch = split ? undefined : "touch-auto!";
  return (
    <div ref={rootRef}
      className={cn(
        "flex h-full min-h-0 flex-col",
        !split && pane === "canvas" && "[&_[data-design-pane=chat]]:hidden!",
        !split && pane === "chat" && "[&_[data-design-pane=canvas]]:hidden!",
      )}
      data-design-view={split ? "split" : pane}
      data-design-resizing={resizing ? "" : undefined}
      onPointerDownCapture={onPointerDownCapture}>
      <div className="min-h-0 flex-1">
        <Group orientation="horizontal" disabled={!split} onLayoutChanged={onLayoutChanged} style={{ height: "100%" }}>
          {/* Sizes are percentage strings: bare numbers mean pixels in this library. */}
          <Panel id={CHAT_PANEL_ID} data-design-pane="chat" className={panelTouch}
            defaultSize={`${clampChatPercent(chatPercent)}%`} minSize="20%" maxSize="70%">
            <div className={cn("flex h-full min-w-0 flex-col", split && "border-r border-border")}>
              {layout.switcher === "toolbar" && <DesignChatPaneHeader layout={layout} />}
              <div className="min-h-0 flex-1" data-design-chat-slot="">{chat}</div>
            </div>
          </Panel>
          <Separator disabled={!split}
            className={cn("w-1 cursor-col-resize bg-border/30 transition-colors hover:bg-primary/30 active:bg-primary/50", !split && "hidden")} />
          <Panel data-design-pane="canvas" className={panelTouch} minSize="25%">
            {canvas({ open: moreOpen, onClose: () => setMoreOpen(false) })}
          </Panel>
        </Group>
      </div>
      {layout.switcher === "phone" && (
        <DesignMobilePaneBar pane={pane} onPaneChange={layout.setPane}
          onMore={() => { layout.setPane("canvas"); setMoreOpen(true); }} />
      )}
    </div>
  );
}
