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

/** Keyed by session, as a chat's transcript is replaced behind its loading screen. */
function SessionTranscript({ metadata }: { metadata?: Record<string, unknown> }) {
  return <div key={String(metadata?.session)} data-testid="scroller" style={{ overflowY: "auto" }} />;
}

const userScroll = (el: HTMLElement, top: number) => {
  el.scrollTop = top;
  el.dispatchEvent(new Event("scroll"));
};

const tick = () => new Promise((r) => setTimeout(r, 5));

/** Whether `ref`'s target is gone after a few full collections. */
async function collected(ref: WeakRef<object>): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    Bun.gc(true);
    // Collect and read in separate tasks: `deref()` keeps its target alive until its task ends.
    await tick();
    if (!ref.deref()) return true;
    await tick();
  }
  return false;
}

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

  it("does not keep a scroller React removed alive, even when nothing scrolls after it", async () => {
    // The record held its elements, and so the whole tree each was removed with: every session
    // switch left the previous transcript's DOM behind, because stick-to-bottom has scrolled any
    // transcript taller than the view by then. Pruning when another scroller turns up is not
    // enough — a next session that fits the view never scrolls.
    const hidden = document.body.appendChild(document.createElement("div"));
    const slot = document.body.appendChild(document.createElement("div"));
    registerPanelSlot("panel-c", slot);
    const tab = (session: number) => (
      <ReparentingTab tabId="chat-3" panelId="panel-c" component={SessionTranscript} metadata={{ session }} isActive hiddenContainer={hidden} />
    );
    const view = await mount(tab(1));
    try {
      // In a function of its own, so no variable here holds the old scroller.
      const old = (() => {
        const el = slot.querySelector<HTMLElement>("[data-testid=scroller]")!;
        userScroll(el, 120);
        return new WeakRef(el);
      })();
      await view.rerender(tab(2));
      expect(await collected(old)).toBe(true);
    } finally {
      await view.unmount();
      registerPanelSlot("panel-c", null);
      hidden.remove();
      slot.remove();
    }
  });
});
