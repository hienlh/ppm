/**
 * The phone viewer's two easier right clicks, driven through the real hook with real touch
 * events: holding one finger still for LONG_PRESS_MS, and the toolbar's Right click button that
 * turns the next tap into one. What is asserted is what the hook sends to the host.
 *
 * The timer must die with the touch: a touchcancel (the browser taking the gesture over) or a
 * drag must never leave a right click to fire later into whatever the finger was doing.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { useRef } from "react";
import { mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";
import {
  useRemoteDesktopTouch, type RemoteDesktopInputMode,
} from "../../../src/web/components/remote-desktop/use-remote-desktop-touch.ts";
import { LONG_PRESS_MS } from "../../../src/web/components/remote-desktop/remote-desktop-touch-gesture-tracker.ts";

const BOX = { left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400, x: 0, y: 0 };

let mounted: Mounted | null = null;
let sent: Record<string, unknown>[] = [];
let used = 0;

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  uninstallDom();
});

function Harness({ mode, armed }: { mode: RemoteDesktopInputMode; armed: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useRemoteDesktopTouch({
    containerRef,
    canvasRef,
    mode,
    enabled: true,
    sendMessage: (m) => { sent.push(m); },
    rightClickArmed: armed,
    onRightClickUsed: () => { used += 1; },
  });
  return (
    <div
      data-testid="stage"
      ref={(el) => {
        containerRef.current = el;
        if (el) el.getBoundingClientRect = () => BOX as DOMRect;
      }}
    >
      {/* Square capture in a square box: no letterbox, so fractions read straight off BOX. */}
      <canvas ref={(el) => { canvasRef.current = el; if (el) { el.width = 1000; el.height = 1000; } }} />
    </div>
  );
}

async function setup(mode: RemoteDesktopInputMode, armed = false): Promise<HTMLElement> {
  sent = [];
  used = 0;
  mounted = await mount(<Harness mode={mode} armed={armed} />);
  return mounted.container.querySelector("[data-testid=stage]") as HTMLElement;
}

function touch(target: HTMLElement, type: string, points: { x: number; y: number }[], changed = points) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  const list = (ps: { x: number; y: number }[]) => ps.map((p) => ({ clientX: p.x, clientY: p.y }));
  Object.defineProperty(e, "touches", { value: type === "touchend" || type === "touchcancel" ? [] : list(points) });
  Object.defineProperty(e, "changedTouches", { value: list(changed) });
  target.dispatchEvent(e);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clicks = () => sent.filter((m) => m.button === "left" || m.button === "right");

describe("long press = right click", () => {
  it("mouse mode: holding still right-clicks at the cursor, and lifting does not click again", async () => {
    const stage = await setup("mouse");
    touch(stage, "touchstart", [{ x: 40, y: 360 }]);
    await sleep(LONG_PRESS_MS + 80);
    expect(clicks()).toEqual([
      { type: "pointer", xFrac: 0.5, yFrac: 0.5, button: "right", down: true },
      { type: "pointer", xFrac: 0.5, yFrac: 0.5, button: "right", down: false },
    ]);
    touch(stage, "touchend", [], [{ x: 40, y: 360 }]);
    expect(clicks()).toHaveLength(2);
  });

  it("touch mode: holding still right-clicks where the finger is", async () => {
    const stage = await setup("touch");
    touch(stage, "touchstart", [{ x: 100, y: 300 }]);
    await sleep(LONG_PRESS_MS + 80);
    touch(stage, "touchend", [], [{ x: 100, y: 300 }]);
    expect(clicks()).toEqual([
      { type: "pointer", xFrac: 0.25, yFrac: 0.75, button: "right", down: true },
      { type: "pointer", xFrac: 0.25, yFrac: 0.75, button: "right", down: false },
    ]);
  });

  it("a touchcancel before the hold completes leaves nothing to fire", async () => {
    const stage = await setup("mouse");
    touch(stage, "touchstart", [{ x: 200, y: 200 }]);
    await sleep(LONG_PRESS_MS / 2);
    touch(stage, "touchcancel", []);
    await sleep(LONG_PRESS_MS);
    expect(clicks()).toEqual([]);
  });

  it("a finger that moves is a drag, not a hold", async () => {
    for (const mode of ["mouse", "touch"] as const) {
      const stage = await setup(mode);
      touch(stage, "touchstart", [{ x: 200, y: 200 }]);
      touch(stage, "touchmove", [{ x: 240, y: 200 }]);
      await sleep(LONG_PRESS_MS + 80);
      expect(sent.some((m) => m.button === "right")).toBe(false);
      touch(stage, "touchend", [], [{ x: 240, y: 200 }]);
      await mounted?.unmount();
      mounted = null;
    }
  });

  it("a second finger cancels the hold (it becomes a two-finger gesture)", async () => {
    const stage = await setup("touch");
    touch(stage, "touchstart", [{ x: 200, y: 200 }]);
    touch(stage, "touchstart", [{ x: 200, y: 200 }, { x: 260, y: 200 }]);
    await sleep(LONG_PRESS_MS + 80);
    expect(clicks()).toEqual([]);
  });

  it("a quick tap is still a left click", async () => {
    const stage = await setup("touch");
    touch(stage, "touchstart", [{ x: 100, y: 100 }]);
    touch(stage, "touchend", [], [{ x: 100, y: 100 }]);
    await sleep(LONG_PRESS_MS + 80);
    expect(clicks()).toEqual([
      { type: "pointer", xFrac: 0.25, yFrac: 0.25, button: "left", down: true },
      { type: "pointer", xFrac: 0.25, yFrac: 0.25, button: "left", down: false },
    ]);
  });
});

describe("Right click button", () => {
  it("mouse mode: the next tap right-clicks at the cursor and turns the button off", async () => {
    const stage = await setup("mouse", true);
    touch(stage, "touchstart", [{ x: 10, y: 10 }]);
    touch(stage, "touchend", [], [{ x: 10, y: 10 }]);
    expect(clicks()).toEqual([
      { type: "pointer", xFrac: 0.5, yFrac: 0.5, button: "right", down: true },
      { type: "pointer", xFrac: 0.5, yFrac: 0.5, button: "right", down: false },
    ]);
    expect(used).toBe(1);
  });

  it("touch mode: the next tap right-clicks where it lands", async () => {
    const stage = await setup("touch", true);
    touch(stage, "touchstart", [{ x: 300, y: 100 }]);
    touch(stage, "touchend", [], [{ x: 300, y: 100 }]);
    expect(clicks()[0]).toEqual({ type: "pointer", xFrac: 0.75, yFrac: 0.25, button: "right", down: true });
    expect(used).toBe(1);
  });

  it("moving the cursor does not use it up", async () => {
    const stage = await setup("mouse", true);
    touch(stage, "touchstart", [{ x: 100, y: 100 }]);
    touch(stage, "touchmove", [{ x: 160, y: 100 }]);
    touch(stage, "touchend", [], [{ x: 160, y: 100 }]);
    expect(clicks()).toEqual([]);
    expect(used).toBe(0);
  });
});
