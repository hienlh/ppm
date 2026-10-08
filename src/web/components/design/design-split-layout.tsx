import {
  useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject,
} from "react";
import { Group, Panel, Separator, type Layout } from "react-resizable-panels";
import { cn } from "@/lib/utils";
import {
  clampChatPercent, clampWindowChatWidth, loadDesignViewPrefs, saveDesignViewPrefs, withChatPercent, withWindowChatWidth,
  MAX_WINDOW_CHAT_WIDTH, MIN_WINDOW_CHAT_WIDTH,
} from "@/lib/design/design-view-prefs";
import type { DesignLayoutControls } from "./design-tab-context";
import { DesignChatPaneHeader } from "./design-layout-controls";
import { DesignMobilePaneBar } from "./design-mobile-layout";

const CHAT_PANEL_ID = "design-chat";

/**
 * In a floating window the chat is a column after the canvas, `--design-chat-w` wide and
 * never more than half the window. The panels keep their DOM order (moving the iframe would
 * reload the design), so the order and sizes are set on the library's panel wrappers by
 * descendant rules, `!important` to beat its inline flex.
 */
const WINDOW_COLUMNS = [
  "[&_[data-design-pane=canvas]]:order-1! [&_[data-design-pane=canvas]]:grow! [&_[data-design-pane=canvas]]:basis-0!",
  "[&_[data-design-pane=chat]]:order-3! [&_[data-design-pane=chat]]:grow-0! [&_[data-design-pane=chat]]:shrink-0!",
  "[&_[data-design-pane=chat]]:basis-[min(var(--design-chat-w),50%)]!",
].join(" ");

/** Arrow-key step for the window chat column's handle. */
const WIDTH_STEP = 20;

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
  const [windowChatWidth, setWindowChatWidth] = useState(() => loadDesignViewPrefs().windowChatWidth);
  const [resizing, setResizing] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // Read by the layout callback, which must not record a share while a pane is hidden, nor
  // while a window's fixed chat column stands in for the split.
  const splitRef = useRef(layout.split && !layout.windowed);
  splitRef.current = layout.split && !layout.windowed;

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

  const { split, pane, windowed } = layout;
  // A window's split is not the user's to drag: the chat is a fixed column on the right.
  const draggable = split && !windowed;
  // One pane shows no separator, so the library's hold on touch gestures (`pan-y` for a
  // horizontal group) would only stop a design from scrolling sideways under a finger.
  const panelTouch = split ? undefined : "touch-auto!";

  // The window column's width: written straight to the root while dragging (no re-render per
  // pointermove), committed to state and the device's prefs when the drag or key press ends.
  const commitWidth = useCallback((width: number) => {
    const next = clampWindowChatWidth(width);
    rootRef.current?.style.setProperty("--design-chat-w", `${next}px`);
    setWindowChatWidth(next);
    saveDesignViewPrefs(withWindowChatWidth(loadDesignViewPrefs(), next));
  }, [rootRef]);

  return (
    <div ref={rootRef}
      style={windowed ? ({ "--design-chat-w": `${windowChatWidth}px` } as CSSProperties) : undefined}
      className={cn(
        "flex h-full min-h-0 flex-col",
        !split && pane === "canvas" && "[&_[data-design-pane=chat]]:hidden!",
        !split && pane === "chat" && "[&_[data-design-pane=canvas]]:hidden!",
        windowed && split && WINDOW_COLUMNS,
      )}
      data-design-view={split ? "split" : pane}
      data-design-resizing={resizing ? "" : undefined}
      onPointerDownCapture={onPointerDownCapture}>
      <div className="min-h-0 flex-1">
        <Group orientation="horizontal" disabled={!draggable} onLayoutChanged={onLayoutChanged} style={{ height: "100%" }}>
          {/* Sizes are percentage strings: bare numbers mean pixels in this library. */}
          <Panel id={CHAT_PANEL_ID} data-design-pane="chat" className={panelTouch}
            defaultSize={`${clampChatPercent(chatPercent)}%`} minSize="20%" maxSize="70%">
            <div className={cn("relative flex h-full min-w-0 flex-col", split && (windowed ? "border-l border-border-soft" : "border-r border-border"))}>
              {windowed && split && (
                <WindowChatHandle width={windowChatWidth} rootRef={rootRef} onResizing={setResizing} onCommit={commitWidth} />
              )}
              {layout.switcher === "toolbar" && <DesignChatPaneHeader layout={layout} />}
              <div className="min-h-0 flex-1" data-design-chat-slot="">{chat}</div>
            </div>
          </Panel>
          <Separator disabled={!draggable}
            className={cn("w-1 cursor-col-resize bg-border/30 transition-colors hover:bg-primary/30 active:bg-primary/50", !draggable && "hidden")} />
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

/**
 * The window chat column's left edge, dragged to widen or narrow the chat (or moved with the
 * arrow keys). Raises `onResizing` for the drag so the canvas iframe stops swallowing the
 * pointer, the same guard the tab's split uses.
 */
function WindowChatHandle({ width, rootRef, onResizing, onCommit }: {
  width: number;
  rootRef: RefObject<HTMLDivElement | null>;
  onResizing: (resizing: boolean) => void;
  onCommit: (width: number) => void;
}) {
  const drag = useRef<{ x: number; width: number; last: number } | null>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const start = e.currentTarget.parentElement?.getBoundingClientRect().width ?? width;
    drag.current = { x: e.clientX, width: start, last: start };
    onResizing(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    // The column sits on the right, so dragging left widens it.
    d.last = clampWindowChatWidth(d.width + (d.x - e.clientX));
    rootRef.current?.style.setProperty("--design-chat-w", `${d.last}px`);
  };
  const end = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    onResizing(false);
    onCommit(d.last);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Chat width"
      aria-valuenow={width}
      aria-valuemin={MIN_WINDOW_CHAT_WIDTH}
      aria-valuemax={MAX_WINDOW_CHAT_WIDTH}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        onCommit(width + (e.key === "ArrowLeft" ? WIDTH_STEP : -WIDTH_STEP));
      }}
      className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none outline-none transition-colors hover:bg-primary/30 focus-visible:bg-primary/40 active:bg-primary/50"
    />
  );
}
