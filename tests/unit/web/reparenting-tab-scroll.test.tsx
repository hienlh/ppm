/**
 * A tab comes back where the reader left it after its panel unmounted first.
 *
 * On a project switch the old panel's slot leaves the page with the tab's wrapper still inside,
 * and a browser resets every scroll offset of a node that leaves the page. Reading the offsets
 * when the wrapper is moved into the new slot is too late — they are already zero. A chat then
 * came back at its top, and its history loader took that for the reader scrolling up and fetched
 * another page on every switch back. happy-dom keeps offsets across a move, so the reset is
 * done by hand here, the way the browser does it: with no scroll event.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { installDom, uninstallDom, mount } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);

const { ReparentingTab } = await import("../../../src/web/components/layout/reparenting-tab");
const { registerPanelSlot } = await import("../../../src/web/components/layout/tab-pool-registry");

function Transcript() {
  return <div data-testid="scroller" style={{ overflowY: "auto" }} />;
}

const userScroll = (el: HTMLElement, top: number) => {
  el.scrollTop = top;
  el.dispatchEvent(new Event("scroll"));
};

describe("a tab moved between panel slots", () => {
  it("comes back at the reader's position after its old panel left the page first", async () => {
    const hidden = document.body.appendChild(document.createElement("div"));
    const first = document.body.appendChild(document.createElement("div"));
    registerPanelSlot("panel-a", first);
    // A new element each time, as TabPool renders it: the same one would let React skip the render.
    const tab = () => (
      <ReparentingTab tabId="chat-1" panelId="panel-a" component={Transcript} isActive hiddenContainer={hidden} />
    );
    const view = await mount(tab());
    try {
      const scroller = first.querySelector<HTMLElement>("[data-testid=scroller]")!;
      expect(scroller).toBeTruthy();
      userScroll(scroller, 480);

      // Switch away: the panel unmounts with the wrapper in it, and the offset is gone.
      first.remove();
      scroller.scrollTop = 0;
      registerPanelSlot("panel-a", null);
      await view.rerender(tab());
      expect(scroller.closest("div[data-tab-pool-id]")!.parentElement).toBe(hidden);
      // Whatever scrolls it while parked is not the reader.
      userScroll(scroller, 0);

      // Switch back: a new slot for the same panel.
      const second = document.body.appendChild(document.createElement("div"));
      registerPanelSlot("panel-a", second);
      await view.rerender(tab());
      expect(second.contains(scroller)).toBe(true);
      expect(scroller.scrollTop).toBe(480);
      second.remove();
    } finally {
      await view.unmount();
      registerPanelSlot("panel-a", null);
      hidden.remove();
    }
  });

  it("writes no offsets on a plain tab switch, and puts back those of a tab moved while hidden", async () => {
    const hidden = document.body.appendChild(document.createElement("div"));
    const first = document.body.appendChild(document.createElement("div"));
    registerPanelSlot("panel-b", first);
    const tab = (isActive: boolean) => (
      <ReparentingTab tabId="chat-2" panelId="panel-b" component={Transcript} isActive={isActive} hiddenContainer={hidden} />
    );
    const view = await mount(tab(true));
    try {
      const scroller = first.querySelector<HTMLElement>("[data-testid=scroller]")!;
      userScroll(scroller, 300);
      // Each write makes a browser lay the whole tab out before it may go on.
      let writes = 0;
      let top = scroller.scrollTop;
      Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => top, set: (v: number) => { writes++; top = v; } });

      await view.rerender(tab(false));
      await view.rerender(tab(true));
      expect(writes).toBe(0);

      // Hidden, then its panel goes away and comes back: moved with no layout to restore into.
      await view.rerender(tab(false));
      first.remove();
      top = 0;
      registerPanelSlot("panel-b", null);
      await view.rerender(tab(false));
      const second = document.body.appendChild(document.createElement("div"));
      registerPanelSlot("panel-b", second);
      await view.rerender(tab(false));
      expect(second.contains(scroller)).toBe(true);
      await view.rerender(tab(true));
      expect(scroller.scrollTop).toBe(300);
      second.remove();
    } finally {
      await view.unmount();
      registerPanelSlot("panel-b", null);
      hidden.remove();
    }
  });
});
