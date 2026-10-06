/**
 * On a phone the adaptive context menu opens its sheet from a press held on the trigger — and
 * lifting that finger must not also be a tap.
 *
 * The sheet opens on our own timer (400 ms). A browser decides for itself when a touch stops being
 * a tap: 500 ms on a phone by default, 1 s or 1.5 s when Android's "Touch & hold delay" is set
 * longer, 1 s in desktop Chromium. A finger lifted inside that gap is a tap to the browser, and the
 * click it makes lands on the sheet's backdrop — which closes the sheet the press just opened.
 * Measured in Chromium at 390 × 844: the sheet was up at 600 ms and gone the moment the finger
 * lifted. Cancelling that `touchend` is what tells the browser there is no tap to click; a short
 * tap's `touchend` has to stay untouched, or the trigger's own click stops working.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { act } = await import("react");
const { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } = await import("../../../src/web/components/ui/adaptive-context-menu");

/** The trigger's own timer, plus a margin. */
const HELD_MS = 450;

const realWidth = window.innerWidth;
let mounted: Mounted | null = null;
beforeEach(() => Object.defineProperty(window, "innerWidth", { value: 390, configurable: true }));
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true });
});

async function mountRow(): Promise<HTMLElement> {
  mounted = await mount(
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div data-testid="row">a row</div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem>Edit connection…</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>,
  );
  return mounted.container.querySelector<HTMLElement>('[data-testid="row"]')!;
}

/** Dispatches one touch event and says whether a handler cancelled it. */
async function touch(el: Element, type: "touchstart" | "touchend"): Promise<boolean> {
  const event = new TouchEvent(type, { bubbles: true, cancelable: true });
  await act(async () => { el.dispatchEvent(event); });
  return event.defaultPrevented;
}
const sheetShows = () => [...document.body.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Edit connection…");

describe("a press held on the trigger", () => {
  it("opens the sheet, and the finger lifting is not a tap that would close it", async () => {
    const row = await mountRow();
    await touch(row, "touchstart");
    await act(async () => { await Bun.sleep(HELD_MS); });
    expect(sheetShows()).toBe(true);
    expect(await touch(row, "touchend")).toBe(true);
    expect(sheetShows()).toBe(true);
  });

  it("leaves a tap's touchend alone, so the tap still clicks", async () => {
    const row = await mountRow();
    await touch(row, "touchstart");
    await act(async () => { await Bun.sleep(50); });
    expect(await touch(row, "touchend")).toBe(false);
    expect(sheetShows()).toBe(false);
  });

  it("leaves the next tap alone once a press has opened and closed the sheet", async () => {
    const row = await mountRow();
    await touch(row, "touchstart");
    await act(async () => { await Bun.sleep(HELD_MS); });
    await touch(row, "touchend");
    await touch(row, "touchstart");
    expect(await touch(row, "touchend")).toBe(false);
  });
});
