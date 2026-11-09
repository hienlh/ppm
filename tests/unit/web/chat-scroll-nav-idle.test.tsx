/**
 * The message navigator follows the transcript only while it is open.
 *
 * At rest it is a single puck that shows nothing about the position. It still listened to every
 * scroll and measured every user row each time, and a streaming answer scrolls the transcript on
 * every flush, so that work ran ten times a second for a display nobody could see.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { installDom, uninstallDom, installGlobal, mount, click } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
installGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

const { act } = await import("react");
const { ChatScrollNav } = await import("../../../src/web/components/chat/chat-scroll-nav");

describe("the message navigator", () => {
  it("measures nothing while closed, and shows the position as soon as it opens", async () => {
    const frames: FrameRequestCallback[] = [];
    const realRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => frames.push(cb)) as typeof requestAnimationFrame;
    const scroller = document.body.appendChild(document.createElement("div"));
    for (let i = 0; i < 6; i++) {
      const row = scroller.appendChild(document.createElement("div"));
      row.dataset.msgIndex = String(i);
    }
    let queries = 0;
    const query = scroller.querySelectorAll.bind(scroller);
    scroller.querySelectorAll = ((selector: string) => { queries++; return query(selector); }) as typeof scroller.querySelectorAll;
    const view = await mount(
      <ChatScrollNav scrollElement={scroller as HTMLDivElement} userIndices={[0, 2, 4]} scrollToBottom={() => {}} />,
    );
    try {
      for (let i = 0; i < 10; i++) {
        await act(async () => {
          scroller.dispatchEvent(new Event("scroll"));
          for (const cb of frames.splice(0)) cb(0);
        });
      }
      expect(queries).toBe(0);

      await click(view.container.querySelector('[aria-label="Navigate messages"]'));
      expect(queries).toBeGreaterThan(0);
      expect(view.container.querySelector('[aria-label^="Message "]')?.textContent).toMatch(/\/3$/);
    } finally {
      await view.unmount();
      scroller.remove();
      globalThis.requestAnimationFrame = realRaf;
    }
  });
});
