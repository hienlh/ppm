/**
 * The eight invisible grab strips around a window. Corners sit on top of the edges, matching
 * the hit areas desktop window managers use.
 *
 * A window at this size can be reached with a finger — a tablet past the `md` breakpoint gets
 * the desktop layer — and a 6 px strip is far below any touch target, so the grab areas grow
 * on coarse pointers. They are transparent, so nothing about the window's look changes.
 */

import { useMediaQuery } from "@/hooks/use-media-query";
import { RESIZE_HANDLES, type ResizeHandle } from "./window-geometry";

type HandleBinder = (handle: ResizeHandle) => Record<string, unknown>;

interface HandleSizes {
  edge: number;
  corner: number;
}

const MOUSE_SIZES: HandleSizes = { edge: 6, corner: 12 };
const TOUCH_SIZES: HandleSizes = { edge: 12, corner: 20 };

const CURSORS: Record<ResizeHandle, string> = {
  n: "cursor-n-resize",
  s: "cursor-s-resize",
  e: "cursor-e-resize",
  w: "cursor-w-resize",
  ne: "cursor-ne-resize",
  nw: "cursor-nw-resize",
  se: "cursor-se-resize",
  sw: "cursor-sw-resize",
};

/**
 * Absolute placement per handle, expressed in the same units the frame uses. Each strip is
 * centred on its border, so half of the extra width grows outwards and half inwards — the
 * window's own border never moves.
 */
function styleFor(handle: ResizeHandle, sizes: HandleSizes): React.CSSProperties {
  const corner = handle.length === 2;
  const s: React.CSSProperties = { position: "absolute", touchAction: "none", zIndex: 1 };
  if (handle.includes("n")) s.top = -sizes.edge / 2;
  if (handle.includes("s")) s.bottom = -sizes.edge / 2;
  if (handle.includes("w")) s.left = -sizes.edge / 2;
  if (handle.includes("e")) s.right = -sizes.edge / 2;
  if (corner) {
    s.width = sizes.corner;
    s.height = sizes.corner;
    return s;
  }
  // Edge strips stop short of the corners so the corner handles keep their full hit area.
  if (handle === "n" || handle === "s") {
    s.left = sizes.corner;
    s.right = sizes.corner;
    s.height = sizes.edge;
  } else {
    s.top = sizes.corner;
    s.bottom = sizes.corner;
    s.width = sizes.edge;
  }
  return s;
}

export function WindowResizeHandles({ bind }: { bind: HandleBinder }) {
  const coarsePointer = useMediaQuery("(pointer: coarse)");
  const sizes = coarsePointer ? TOUCH_SIZES : MOUSE_SIZES;
  return (
    <>
      {RESIZE_HANDLES.map((handle) => (
        <div
          key={handle}
          {...bind(handle)}
          data-resize-handle={handle}
          aria-hidden
          className={CURSORS[handle]}
          style={styleFor(handle, sizes)}
        />
      ))}
    </>
  );
}
