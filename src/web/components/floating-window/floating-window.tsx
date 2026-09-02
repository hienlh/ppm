/**
 * One floating window: geometry, gestures, keyboard, and a chrome slot.
 *
 * Geometry is written straight to the element instead of through React state — a drag emits
 * a pointermove per frame and re-rendering the window (and its content) on each one is what
 * makes a window manager feel heavy. The store is written only when a gesture ends, which is
 * also the moment the rect is rounded to whole pixels.
 */

import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { DefaultWindowChrome } from "./default-window-chrome";
import { TITLEBAR_HEIGHT, type WindowChrome } from "./window-chrome-contract";
import { windowZIndex, type Bounds, type Rect } from "./window-geometry";
import { useWindowStore, type WindowRuntimeState } from "./window-store";
import { useWindowDrag } from "./use-window-drag";
import { useWindowKeyboard } from "./use-window-keyboard";
import { useWindowResize } from "./use-window-resize";
import { WindowResizeHandles } from "./window-resize-handles";

export interface FloatingWindowProps {
  win: WindowRuntimeState;
  /** Size of the layer container; a maximized window fills exactly this. */
  bounds: Bounds;
  title: string;
  focused: boolean;
  /** Reads the layer's CSS scale so pointer deltas can be corrected. */
  getScale: () => number;
  /** Told when a gesture starts/ends so the layer can raise its capture overlay. */
  onGestureActive: (active: boolean) => void;
  /** Skin component for the titlebar; owns its own hooks and state. */
  chrome?: WindowChrome;
  children: ReactNode;
}

function applyRect(el: HTMLElement | null, rect: Rect, collapsed: boolean): void {
  if (!el) return;
  el.style.transform = `translate3d(${Math.round(rect.x)}px, ${Math.round(rect.y)}px, 0)`;
  el.style.width = `${Math.round(rect.w)}px`;
  el.style.height = collapsed ? `${TITLEBAR_HEIGHT}px` : `${Math.round(rect.h)}px`;
}

export function FloatingWindow({
  win,
  bounds,
  title,
  focused,
  getScale,
  onGestureActive,
  chrome,
  children,
}: FloatingWindowProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [gesturing, setGesturing] = useState(false);

  const maximized = win.state === "maximized";
  const minimized = win.state === "minimized";
  const rect: Rect = maximized ? { x: 0, y: 0, w: bounds.w, h: bounds.h } : win.rect;

  // Latest committed geometry, read at the first frame of a gesture (never mid-gesture,
  // where it would compound the cumulative movement).
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;

  useLayoutEffect(() => {
    applyRect(rootRef.current, rectRef.current, minimized);
  }, [rect.x, rect.y, rect.w, rect.h, minimized]);

  const setActive = useCallback(
    (active: boolean) => {
      setGesturing(active);
      onGestureActive(active);
    },
    [onGestureActive],
  );

  const commitMove = useCallback((next: Rect, committed: boolean) => {
    applyRect(rootRef.current, next, useWindowStore.getState().windows[win.id]?.state === "minimized");
    if (committed) useWindowStore.getState().move(win.id, { x: next.x, y: next.y });
  }, [win.id]);

  const commitResize = useCallback((next: Rect, committed: boolean) => {
    applyRect(rootRef.current, next, false);
    if (committed) useWindowStore.getState().resize(win.id, next);
  }, [win.id]);

  const shared = {
    getRect: () => rectRef.current,
    getBounds: () => boundsRef.current,
    getScale,
    onGestureActive: setActive,
  };
  const bindDrag = useWindowDrag({ ...shared, onChange: commitMove, disabled: maximized });
  const bindResize = useWindowResize({ ...shared, onChange: commitResize, disabled: maximized || minimized });

  const close = useCallback(() => useWindowStore.getState().close(win.id), [win.id]);
  const toggleMaximize = useCallback(() => {
    useWindowStore.getState().setState(win.id, maximized ? "normal" : "maximized");
  }, [win.id, maximized]);
  const minimize = useCallback(() => {
    useWindowStore.getState().setState(win.id, minimized ? "normal" : "minimized");
  }, [win.id, minimized]);

  const onKeyDown = useWindowKeyboard({
    getRect: () => rectRef.current,
    getBounds: () => boundsRef.current,
    onMove: (next) => useWindowStore.getState().move(win.id, { x: next.x, y: next.y }),
    onToggleMaximize: toggleMaximize,
    onClose: close,
    movable: !maximized,
  });

  const Chrome = chrome ?? DefaultWindowChrome;

  return (
    <div
      ref={rootRef}
      role="group"
      aria-roledescription="window"
      aria-label={title}
      // Any pointer inside the window raises it, including clicks on its content.
      onPointerDownCapture={() => useWindowStore.getState().focus(win.id)}
      style={{ zIndex: windowZIndex(win.rank) }}
      className={cn(
        "absolute left-0 top-0 flex flex-col pointer-events-auto",
        "rounded-[8px] border border-border bg-panel overflow-visible",
        focused ? "shadow-2xl shadow-black/40" : "shadow-lg shadow-black/20",
        // Transitions are for maximize/restore only; during a gesture they would lag the pointer.
        gesturing ? "transition-none" : "transition-[transform,width,height] duration-150 motion-reduce:transition-none",
      )}
    >
      <Chrome
        id={win.id}
        kind={win.kind}
        title={title}
        state={win.state}
        focused={focused}
        titlebarProps={{
          ...(bindDrag() as Record<string, unknown>),
          onKeyDown,
          tabIndex: 0,
          role: "toolbar",
          "aria-label": `${title} title bar`,
          // Scoped here rather than on document: a global user-select hack leaks into
          // unrelated panels and survives a gesture that ends outside the window.
          style: { touchAction: "none", userSelect: "none" },
        }}
        onMinimize={minimize}
        onToggleMaximize={toggleMaximize}
        onClose={close}
      />


      {/* Always mounted, even minimized — content owns per-window state (explorer history,
          selection, filter) that a remount would wipe. Hidden via CSS, not unmounted. */}
      <div className={cn("relative flex-1 min-h-0 overflow-hidden rounded-b-[8px] bg-panel", minimized && "hidden")}>
        {children}
      </div>

      {!maximized && !minimized && (
        <WindowResizeHandles bind={(handle) => bindResize(handle) as Record<string, unknown>} />
      )}
    </div>
  );
}
