/**
 * The landing pin: a row put 16 px below the container top stays there while content above it
 * changes height, until the reader scrolls — and a hidden tab or a TabPool move, which reset and
 * restore scroll offsets on their own, never counts as the reader.
 *
 * happy-dom has no layout, so the geometry is played by hand: the container's height, the row's
 * position in the content, and a ResizeObserver whose callback the test fires the way the browser
 * would after a layout change.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { installDom, installGlobal, uninstallDom } from "../../helpers/react-dom";

installDom();
const observers: FakeResizeObserver[] = [];
class FakeResizeObserver {
  constructor(private readonly cb: () => void) { observers.push(this); }
  observe() {}
  unobserve() {}
  disconnect() { observers.splice(observers.indexOf(this), 1); }
  fire() { this.cb(); }
}
installGlobal("ResizeObserver", FakeResizeObserver);
const frames: Array<() => void> = [];
installGlobal("requestAnimationFrame", (cb: () => void) => frames.push(cb));
installGlobal("cancelAnimationFrame", () => {});
const { ScrollAnchorPin, PIN_OFFSET_PX } = await import("../../../src/web/hooks/use-scroll-anchor-pin");
afterAll(() => uninstallDom());

/** A scroll container 600 px tall whose row sits `rowTop` px into the content. */
function scene(onHold?: () => void) {
  const el = document.createElement("div");
  const content = document.createElement("div");
  const row = document.createElement("div");
  content.appendChild(row);
  el.appendChild(content);
  document.body.appendChild(el);
  const g = { height: 600, scrollTop: 0, rowTop: 2000 };
  Object.defineProperty(el, "clientHeight", { get: () => g.height });
  Object.defineProperty(el, "scrollTop", { get: () => g.scrollTop, set: (v: number) => { g.scrollTop = Math.max(0, v); } });
  el.getBoundingClientRect = () => ({ top: 100 } as DOMRect);
  row.getBoundingClientRect = () => ({ top: 100 + g.rowTop - g.scrollTop } as DOMRect);
  const unpinned: number[] = [];
  const pin = new ScrollAnchorPin(el, PIN_OFFSET_PX, () => unpinned.push(1), onHold);
  /** The row's distance from the container's top, as the reader sees it. */
  const offset = () => g.rowTop - g.scrollTop;
  const layout = () => observers.forEach((o) => o.fire());
  const scrollEvent = () => el.dispatchEvent(new window.Event("scroll"));
  return { el, row, g, pin, unpinned, offset, layout, scrollEvent };
}

beforeEach(() => {
  observers.length = 0;
  frames.length = 0;
  document.body.innerHTML = "";
});

describe("ScrollAnchorPin", () => {
  it("puts the row 16 px below the top and keeps it there as content above grows", () => {
    const s = scene();
    s.pin.pin(s.row);
    expect(s.offset()).toBe(16);
    // An image above the row decodes: 340 px taller.
    s.g.rowTop += 340;
    s.layout();
    expect(s.offset()).toBe(16);
    // Our own write fires a scroll event; that is not the reader.
    s.scrollEvent();
    expect(s.unpinned).toEqual([]);
    expect(s.pin.pinned).toBe(s.row);
  });

  it("lets go on the reader's wheel, touch, scroll key, scrollbar press or own scroll", () => {
    const intents: Array<(s: ReturnType<typeof scene>) => void> = [
      (s) => s.el.dispatchEvent(new window.Event("wheel")),
      (s) => s.el.dispatchEvent(new window.Event("touchmove")),
      (s) => s.el.dispatchEvent(new window.KeyboardEvent("keydown", { key: "PageUp" })),
      (s) => s.el.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true })),
      (s) => { s.g.scrollTop -= 200; s.scrollEvent(); },
    ];
    for (const intent of intents) {
      const s = scene();
      s.pin.pin(s.row);
      intent(s);
      expect(s.pin.pinned).toBeNull();
      expect(s.unpinned).toEqual([1]);
      // Unpinned, it no longer corrects anything.
      const before = s.g.scrollTop;
      s.g.rowTop += 100;
      s.layout();
      expect(s.g.scrollTop).toBe(before);
    }
  });

  it("a click on a row or a key that does not scroll is not the reader", () => {
    const s = scene();
    s.pin.pin(s.row);
    s.row.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
    s.el.dispatchEvent(new window.KeyboardEvent("keydown", { key: "c" }));
    expect(s.pin.pinned).toBe(s.row);
  });

  it("typing a space or an arrow into a field inside the container is not the reader", () => {
    const s = scene();
    const field = document.createElement("textarea");
    s.row.appendChild(field);
    s.pin.pin(s.row);
    for (const key of [" ", "ArrowDown", "End"]) field.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }));
    expect(s.pin.pinned).toBe(s.row);
    s.el.dispatchEvent(new window.KeyboardEvent("keydown", { key: " " }));
    expect(s.pin.pinned).toBeNull();
  });

  it("holds a bottom follower off on its own writes, and again just after the follower judged the scroll", async () => {
    const holds: number[] = [];
    const s = scene(() => holds.push(s.g.scrollTop));
    s.pin.pin(s.row);
    expect(holds.length).toBe(1);
    s.scrollEvent();
    await Bun.sleep(10);
    expect(holds.length).toBe(2);
    // A scroll that is not the pin's own lets go, and nothing is held from then on.
    s.g.scrollTop -= 300;
    s.scrollEvent();
    await Bun.sleep(10);
    expect(s.pin.pinned).toBeNull();
    expect(holds.length).toBe(2);
  });

  it("waits out a hidden tab and the offset restore when it is shown again", () => {
    const s = scene();
    s.pin.pin(s.row);
    // TabPool hides the tab: no height, and its offset reads whatever.
    s.g.height = 0;
    s.layout();
    s.g.scrollTop = 0;
    s.scrollEvent();
    s.g.rowTop += 500; // something above grew while hidden
    s.layout();
    expect(s.pin.pinned).toBe(s.row);
    // Shown again: reparenting-tab.tsx writes the old offset back, and that scroll event lands
    // before the ResizeObserver reports the height.
    s.g.height = 600;
    s.g.scrollTop = 1984;
    s.scrollEvent();
    expect(s.pin.pinned).toBe(s.row);
    s.layout();
    // The frame after it reappears is still settling.
    s.g.scrollTop = 1200;
    s.scrollEvent();
    expect(s.pin.pinned).toBe(s.row);
    frames.splice(0).forEach((f) => f());
    expect(s.offset()).toBe(16);
    expect(s.unpinned).toEqual([]);
    // From then on the reader counts again.
    s.g.scrollTop -= 50;
    s.scrollEvent();
    expect(s.pin.pinned).toBeNull();
  });

  it("lets go of a row that left the page", () => {
    const s = scene();
    s.pin.pin(s.row);
    s.row.remove();
    s.layout();
    expect(s.pin.pinned).toBeNull();
  });

  it("stops listening once disposed", () => {
    const s = scene();
    s.pin.pin(s.row);
    s.pin.dispose();
    expect(observers.length).toBe(0);
    s.g.scrollTop -= 300;
    s.scrollEvent();
    expect(s.unpinned).toEqual([]);
  });
});
