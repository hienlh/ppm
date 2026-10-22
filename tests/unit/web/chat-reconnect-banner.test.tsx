/**
 * The chat used to cover itself with a blurred full-screen overlay whenever its
 * socket dropped — which on a phone is every return from another app. The pill
 * that replaced it must stay invisible for a quick reconnect, never block the
 * chat, offer Retry once the reconnect drags on, and not report "lost" just
 * because timers frozen in the background fired on resume.
 */
import { afterAll, afterEach, expect, it } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { act, useState } = await import("react");
const { ChatReconnectBanner } = await import("../../../src/web/components/chat/chat-reconnect-banner");

const SHOW = 40;
const LOST = 120;
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

let view: Mounted | undefined;
afterEach(async () => { await view?.unmount(); view = undefined; });

let setReconnecting!: (v: boolean) => void;
let retries = 0;
function Harness({ initial }: { initial: boolean }) {
  const [reconnecting, update] = useState(initial);
  setReconnecting = update;
  return <ChatReconnectBanner isReconnecting={reconnecting} onRetry={() => { retries++; }} showDelayMs={SHOW} lostAfterMs={LOST} />;
}
const stage = () => view!.container.querySelector("[data-reconnect-stage]")?.getAttribute("data-reconnect-stage") ?? "hidden";

it("shows nothing for a reconnect that finishes within the grace period", async () => {
  view = await mount(<Harness initial={true} />);
  expect(stage()).toBe("hidden");
  await wait(SHOW / 2);
  await act(async () => { setReconnecting(false); });
  await wait(LOST);
  expect(stage()).toBe("hidden");
});

it("shows a non-blocking pill, then Retry once the reconnect drags on", async () => {
  view = await mount(<Harness initial={true} />);
  await wait(SHOW + 20);
  expect(stage()).toBe("reconnecting");
  // Only the pill itself takes pointer events; its full-width wrapper lets touches through.
  const wrapper = view.container.firstElementChild as HTMLElement;
  expect(wrapper.className).toContain("pointer-events-none");
  expect(wrapper.className).not.toContain("inset-0");

  await wait(LOST);
  expect(stage()).toBe("lost");
  retries = 0;
  await click(view.container.querySelector("button"));
  expect(retries).toBe(1);
  // Retry starts a fresh attempt: back to quiet, then "reconnecting" again.
  expect(stage()).toBe("hidden");
  await wait(SHOW + 20);
  expect(stage()).toBe("reconnecting");

  await act(async () => { setReconnecting(false); });
  expect(stage()).toBe("hidden");
});

it("restarts its timers when the page becomes visible, so a resume is not reported lost", async () => {
  view = await mount(<Harness initial={true} />);
  await wait(LOST + 20);
  expect(stage()).toBe("lost");

  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(stage()).toBe("hidden");
  await wait(SHOW + 20);
  expect(stage()).toBe("reconnecting");
});
