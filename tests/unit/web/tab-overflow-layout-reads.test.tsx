/**
 * The tab bar measures its strip once a frame, and only when it has to.
 *
 * Its mutation observer fires straight after every commit, where reading a width forces the
 * browser to lay out the whole page. A project switch puts whole transcripts back on screen,
 * and a CPU profile of one charged ~48 ms to that read alone. The unread-arrow check runs
 * during render and read the strip's geometry even when no tab had anything unread.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { installDom, uninstallDom, installGlobal, mount } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
installGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
installGlobal("MutationObserver", (window as unknown as { MutationObserver: typeof MutationObserver }).MutationObserver);

const { act, useRef } = await import("react");
const { useTabOverflow, getHiddenUnreadDirection } = await import("../../../src/web/hooks/use-tab-overflow");

/** An element whose layout reads are counted. */
function counted(el: HTMLElement, reads: { n: number }) {
  for (const prop of ["scrollWidth", "clientWidth", "scrollLeft"] as const) {
    Object.defineProperty(el, prop, { configurable: true, get: () => { reads.n++; return prop === "scrollWidth" ? 900 : prop === "clientWidth" ? 300 : 0; } });
  }
  el.getBoundingClientRect = () => { reads.n++; return { left: 0, right: 300, width: 300, top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON() {} } as DOMRect; };
}

describe("the tab bar's overflow check", () => {
  it("never measures right after a commit, and measures once a frame however many came", async () => {
    const frames: FrameRequestCallback[] = [];
    const realRaf = globalThis.requestAnimationFrame;
    const realCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => frames.push(cb)) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
    const reads = { n: 0 };
    let strip: HTMLDivElement | null = null;
    let state = { canScrollLeft: false, canScrollRight: false };
    function Bar() {
      const ref = useRef<HTMLDivElement>(null);
      state = useTabOverflow(ref);
      return <div ref={(el) => { if (el && el !== strip) { strip = el; counted(el, reads); } (ref as { current: HTMLDivElement | null }).current = el; }} />;
    }
    try {
      const view = await mount(<Bar />);
      const frame = async () => { await act(async () => { for (const cb of frames.splice(0)) cb(0); }); };
      await frame();
      reads.n = 0;

      // Five commits' worth of tabs added: five mutation callbacks.
      for (let i = 0; i < 5; i++) {
        await act(async () => { strip!.appendChild(document.createElement("button")); });
      }
      expect(reads.n).toBe(0);
      expect(frames.length).toBe(1);
      await frame();
      // scrollLeft is read twice, scrollWidth and clientWidth once: one measurement.
      expect(reads.n).toBe(4);
      expect(state.canScrollRight).toBe(true);
      await view.unmount();
    } finally {
      globalThis.requestAnimationFrame = realRaf;
      globalThis.cancelAnimationFrame = realCancel;
    }
  });

  it("reads no geometry while rendering unless a chat tab has something unread", () => {
    const reads = { n: 0 };
    const strip = document.createElement("div");
    counted(strip, reads);
    const tab = document.createElement("div");
    tab.getBoundingClientRect = () => ({ left: 400, right: 500, width: 100 }) as DOMRect;
    const tabs = [{ id: "t1", type: "chat", metadata: { sessionId: "s1" } }];
    const refs = new Map<string, HTMLElement>([["t1", tab]]);

    expect(getHiddenUnreadDirection(strip as HTMLDivElement, refs, tabs, new Map())).toEqual({ left: null, right: null });
    expect(reads.n).toBe(0);

    expect(getHiddenUnreadDirection(strip as HTMLDivElement, refs, tabs, new Map([["s1", { count: 1, type: "done" }]]))).toEqual({ left: null, right: "done" });
    expect(reads.n).toBeGreaterThan(0);
  });
});
