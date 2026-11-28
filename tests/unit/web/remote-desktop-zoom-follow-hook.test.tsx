/**
 * Zoom follow through the real touch hook: pinch to 2x, then drag the Mouse-mode cursor toward
 * the right edge — the picture must slide so the cursor stays inside the view.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { useRef } from "react";
import { mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";
import { useRemoteDesktopTouch } from "../../../src/web/components/remote-desktop/use-remote-desktop-touch.ts";
import { FOLLOW_EDGE_MARGIN_PX } from "../../../src/web/components/remote-desktop/remote-desktop-zoom-follow.ts";

const BOX = { left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400, x: 0, y: 0 };

let mounted: Mounted | null = null;
const record = () => {};

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  uninstallDom();
});

function Harness() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { transform, virtualCursor } = useRemoteDesktopTouch({
    containerRef, canvasRef, mode: "mouse", enabled: true, sendMessage: record,
  });
  return (
    <div
      data-testid="stage"
      data-scale={transform.scale}
      data-pan-x={transform.panX}
      data-cursor-x={virtualCursor?.xFrac ?? ""}
      ref={(el) => {
        containerRef.current = el;
        if (el) el.getBoundingClientRect = () => BOX as DOMRect;
      }}
    >
      {/* Square capture in a square box: no letterbox. */}
      <canvas ref={(el) => { canvasRef.current = el; if (el) { el.width = 1000; el.height = 1000; } }} />
    </div>
  );
}

function touch(target: HTMLElement, type: string, points: { x: number; y: number }[], changed = points) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  const list = (ps: { x: number; y: number }[]) => ps.map((p) => ({ clientX: p.x, clientY: p.y }));
  Object.defineProperty(e, "touches", { value: type === "touchend" ? [] : list(points) });
  Object.defineProperty(e, "changedTouches", { value: list(changed) });
  target.dispatchEvent(e);
}

const frame = () => new Promise((r) => setTimeout(r, 40));

describe("zoom follows the Mouse-mode cursor (hook)", () => {
  it("dragging the cursor toward the edge while zoomed slides the picture", async () => {
    mounted = await mount(<Harness />);
    const stage = mounted.container.querySelector("[data-testid=stage]") as HTMLElement;

    touch(stage, "touchstart", [{ x: 150, y: 200 }, { x: 250, y: 200 }]);
    touch(stage, "touchmove", [{ x: 120, y: 200 }, { x: 280, y: 200 }]);
    touch(stage, "touchmove", [{ x: 100, y: 200 }, { x: 300, y: 200 }]);
    touch(stage, "touchend", [], [{ x: 100, y: 200 }, { x: 300, y: 200 }]);
    await frame();
    expect(Number(stage.dataset.scale)).toBeCloseTo(2, 6);
    expect(Number(stage.dataset.panX)).toBe(0);

    touch(stage, "touchstart", [{ x: 200, y: 200 }]);
    for (const x of [240, 280, 320, 380]) touch(stage, "touchmove", [{ x, y: 200 }]);
    touch(stage, "touchend", [], [{ x: 380, y: 200 }]);
    await frame();

    const panX = Number(stage.dataset.panX);
    const cursorX = Number(stage.dataset.cursorX);
    expect(cursorX).toBeCloseTo(0.725, 6); // 180px of finger at 2x = 90px of desktop
    expect(panX).toBeLessThan(0);
    // The cursor is drawn a margin inside the right edge rather than off screen.
    const onScreen = 200 + panX + (cursorX * 400 - 200) * 2;
    expect(onScreen).toBeCloseTo(BOX.width - FOLLOW_EDGE_MARGIN_PX, 6);
  });
});
