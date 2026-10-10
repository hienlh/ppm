/**
 * Middle-click closes a tab — including in a tab strip that overflows. There a middle press starts
 * Chrome's autoscroll and no `auxclick` follows (measured in headless Chrome: a button inside an
 * `overflow: auto` box got mousedown and mouseup with button 1 and no auxclick), so the tab
 * cancels the middle press itself. Only the middle one: a left press starts a tab drag.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);
const { act } = await import("react");
const { DraggableTab } = await import("../../../src/web/components/layout/draggable-tab");
type Tab = import("../../../src/web/stores/tab-store").Tab;

const FILE: Tab = { id: "editor:a.ts", type: "editor", title: "a.ts", projectId: "p", closable: true, metadata: { filePath: "a.ts" } };
const PINNED: Tab = { ...FILE, id: "editor:b.ts", title: "b.ts", closable: false };

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

const noop = () => {};
async function tabFor(tab: Tab, onClose = noop): Promise<HTMLElement> {
  view = await mount(
    <DraggableTab
      tab={tab} isActive={false} icon={() => null} showDropBefore={false}
      onSelect={noop} onClose={onClose} onDragStart={noop} onDragOver={noop} onDragEnd={noop} tabRef={noop}
    />,
  );
  return document.body.querySelector(`[data-tab-id="${tab.id}"]`) as HTMLElement;
}
/** Dispatches a mouse event; true when the tab cancelled it. */
async function press(el: HTMLElement, type: string, button: number): Promise<boolean> {
  let notCancelled = true;
  await act(async () => { notCancelled = el.dispatchEvent(new MouseEvent(type, { button, bubbles: true, cancelable: true })); });
  return !notCancelled;
}

describe("middle-click on a tab", () => {
  it("cancels the middle press, so an overflowing strip does not start autoscroll and swallow the auxclick", async () => {
    const el = await tabFor(FILE);
    expect(await press(el, "mousedown", 1)).toBe(true);
  });

  it("leaves a left press alone, so the tab can still be dragged", async () => {
    const el = await tabFor(FILE);
    expect(await press(el, "mousedown", 0)).toBe(false);
  });

  it("closes the tab on the auxclick that follows", async () => {
    let closed = 0;
    const el = await tabFor(FILE, () => { closed += 1; });
    await press(el, "mousedown", 1);
    await press(el, "auxclick", 1);
    expect(closed).toBe(1);
  });

  it("does neither for a tab that cannot be closed", async () => {
    let closed = 0;
    const el = await tabFor(PINNED, () => { closed += 1; });
    expect(await press(el, "mousedown", 1)).toBe(false);
    await press(el, "auxclick", 1);
    expect(closed).toBe(0);
  });
});
