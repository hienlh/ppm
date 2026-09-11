/**
 * Two layout traps in the desktop viewer's scale modes, both of which fail by doing *nothing*
 * visible: the mode switches, the menu ticks the new item, and the picture is unchanged. Neither
 * can be caught by testing `canvasCssSize` (which is pure and correct in both cases), so they
 * are pinned against the component source the way `long-press-touchcancel.test.ts` pins its own
 * invisible omission.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const VIEWER = resolve(import.meta.dir, "../../../src/web/components/remote-desktop/remote-desktop-window-content.tsx");
const source = readFileSync(VIEWER, "utf-8");

/** The JSX of the scroll container and the canvas inside it. */
const scrollBox = source.slice(source.indexOf("overflow-auto") - 200, source.indexOf("</div>", source.indexOf("overflow-auto")));

describe("remote-desktop scale modes — canvas layout", () => {
  it("centres the oversized canvas with auto margins, never with justify-center", () => {
    // `justify-content: center` on a scroll container distributes a child's overflow to BOTH
    // sides, and the half before the scroll origin is unreachable — scrolled fully left and up,
    // a 1:1 3440x1440 capture in a small window still hides its own top-left corner. Auto
    // margins centre only while there is free space and collapse to 0 once there is not.
    expect(scrollBox).toContain("m-auto");
    expect(scrollBox).not.toContain("justify-center");
  });

  it("drops max-h-full/max-w-full whenever it sets an explicit canvas size", () => {
    // `max-width: 100%` beats `width: 3440px`, so leaving the fit classes on would clamp the
    // canvas straight back to the container: original and custom would be silent no-ops.
    expect(source).toContain('!cssSize && "max-h-full max-w-full"');
    expect(source).toContain("style={cssSize ? { width: cssSize.width, height: cssSize.height } : undefined}");
  });

  it("keeps the overlays out of the scroll container", () => {
    // The toolbar, the stats overlay and the clipboard notice are `position: absolute` against
    // the viewer root. Inside a scroller they scroll away with the picture instead of floating
    // over it, which is only visible once a mode that actually overflows is picked.
    const scroller = source.indexOf("overflow-auto");
    for (const overlay of ["<RemoteDesktopToolbar", "<RemoteDesktopStatsOverlay", "<RemoteDesktopClipboardNotice"]) {
      expect(source.indexOf(overlay)).toBeGreaterThan(scroller);
      expect(scrollBox).not.toContain(overlay);
    }
  });
});
