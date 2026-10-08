/**
 * Host for all floating windows, sized to the app's content area.
 *
 * It is deliberately a plain absolutely-positioned child of the content wrapper rather than
 * a body-level portal: window coordinates stay relative to the working area, so a maximized
 * window covers the panels but never the nav rail, and the container's own resize is what
 * triggers re-clamping.
 *
 * The layer is desktop-only. Below the `md` breakpoint it renders nothing and never touches
 * the store, leaving the mobile sheet presentation free to own the same content.
 */

import { Suspense, useCallback, useLayoutEffect, useRef, useState } from "react";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { FloatingWindow } from "./floating-window";
import { useWindowMeta } from "./use-window-meta";
import { WINDOW_CONTENT, windowTitle } from "./window-content-registry";
import { snapRect, Z_BASE, MAX_WINDOWS, type Bounds } from "./window-geometry";
import { frontWindowId, useWindowStore, windowsInRankOrder, type WindowRuntimeState } from "./window-store";

export function WindowLayer() {
  const isMobile = useIsMobile();
  if (isMobile) return null;
  return <DesktopWindowLayer />;
}

function DesktopWindowLayer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const windows = useWindowStore((s) => s.windows);
  const bounds = useWindowStore((s) => s.bounds);
  const snapPreview = useWindowStore((s) => s.snapPreviewId !== null);
  const [capturing, setCapturing] = useState(false);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const scale = el.offsetWidth > 0 ? r.width / el.offsetWidth : 1;
      // Report layout pixels, not scaled screen pixels, so rects match the CSS coordinates
      // the windows are positioned in.
      return { w: Math.round(r.width / scale), h: Math.round(r.height / scale) };
    };
    const store = useWindowStore.getState();
    store.setBounds(measure());
    store.restoreAll(measure());
    // Panels, the sidebar and the browser all resize this box; window.resize alone misses
    // the first two and would leave windows stranded outside the layer.
    const observer = new ResizeObserver(() => useWindowStore.getState().setBounds(measure()));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const getScale = useCallback(() => {
    const el = containerRef.current;
    if (!el || el.offsetWidth === 0) return 1;
    return el.getBoundingClientRect().width / el.offsetWidth;
  }, []);

  const ordered = windowsInRankOrder(windows);
  const frontId = frontWindowId(windows);

  return (
    // Stops at the status bar (26px) rather than covering it: the bar holds the window dock,
    // and a maximized or snapped window must never hide the way back to the others.
    <div ref={containerRef} className="absolute inset-x-0 top-0 bottom-[26px] overflow-hidden pointer-events-none">
      {snapPreview && <SnapGhost bounds={bounds} />}

      {ordered.map((win) => (
        <LayerWindow
          key={win.id}
          win={win}
          bounds={bounds}
          focused={win.id === frontId}
          getScale={getScale}
          onGestureActive={setCapturing}
        />
      ))}

      {/* Transparent capture surface: iframes and editors swallow pointer events, which
          would stall a drag the moment the cursor crossed one. Stays inside the window
          z-band so app popovers and dialogs remain above it. */}
      {capturing && (
        <div className="absolute inset-0 pointer-events-auto" style={{ zIndex: Z_BASE + MAX_WINDOWS }} />
      )}
    </div>
  );
}

/** One window with its titlebar identity resolved — a component so the meta hook has a home. */
function LayerWindow({ win, bounds, focused, getScale, onGestureActive }: {
  win: WindowRuntimeState;
  bounds: Bounds;
  focused: boolean;
  getScale: () => number;
  onGestureActive: (active: boolean) => void;
}) {
  const Content = WINDOW_CONTENT[win.kind];
  const meta = useWindowMeta(win);
  return (
    <FloatingWindow
      win={win}
      bounds={bounds}
      title={meta.title || windowTitle(win.kind, win.payload)}
      identity={meta}
      focused={focused}
      getScale={getScale}
      onGestureActive={onGestureActive}
    >
      <Suspense fallback={<div className="p-3 text-xs text-text-2">Loading…</div>}>
        <Content id={win.id} payload={win.payload} />
      </Suspense>
    </FloatingWindow>
  );
}

/** Where a window dragged off the right edge will land when it is let go. */
function SnapGhost({ bounds }: { bounds: Bounds }) {
  const r = snapRect(bounds);
  return (
    <div
      aria-hidden="true"
      className="absolute rounded border-2 border-dashed border-primary bg-accent-wash transition-opacity"
      style={{ left: r.x, top: r.y, width: r.w, height: r.h, zIndex: Z_BASE }}
    />
  );
}
