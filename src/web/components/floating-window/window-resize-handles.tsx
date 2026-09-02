/**
 * The eight invisible grab strips around a window. Edges are 6 px, corners 12 px and sit on
 * top of the edges, matching the hit areas desktop window managers use.
 */

import { RESIZE_HANDLES, type ResizeHandle } from "./window-geometry";

type HandleBinder = (handle: ResizeHandle) => Record<string, unknown>;

const EDGE = 6;
const CORNER = 12;

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

/** Absolute placement per handle, expressed in the same units the frame uses. */
function styleFor(handle: ResizeHandle): React.CSSProperties {
  const corner = handle.length === 2;
  const size = corner ? CORNER : EDGE;
  const s: React.CSSProperties = { position: "absolute", touchAction: "none", zIndex: 1 };
  if (handle.includes("n")) s.top = -EDGE / 2;
  if (handle.includes("s")) s.bottom = -EDGE / 2;
  if (handle.includes("w")) s.left = -EDGE / 2;
  if (handle.includes("e")) s.right = -EDGE / 2;
  if (corner) {
    s.width = size;
    s.height = size;
    return s;
  }
  if (handle === "n" || handle === "s") {
    s.left = CORNER;
    s.right = CORNER;
    s.height = size;
  } else {
    s.top = CORNER;
    s.bottom = CORNER;
    s.width = size;
  }
  return s;
}

export function WindowResizeHandles({ bind }: { bind: HandleBinder }) {
  return (
    <>
      {RESIZE_HANDLES.map((handle) => (
        <div
          key={handle}
          {...bind(handle)}
          data-resize-handle={handle}
          aria-hidden
          className={CURSORS[handle]}
          style={styleFor(handle)}
        />
      ))}
    </>
  );
}
