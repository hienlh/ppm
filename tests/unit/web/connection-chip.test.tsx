/**
 * The chat's connection in the footer's context row. Connected shows nothing; a reconnect that
 * finishes within the grace period never flashes; one that drags on shows a quiet
 * "Reconnecting…", then a red "Connection lost · Retry" whose tap starts a fresh attempt; and
 * timers frozen while the page was hidden do not report a resumed page as lost.
 */
import { afterAll, afterEach, expect, it } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { act, useState } = await import("react");
const { useReconnectIndicator } = await import("../../../src/web/hooks/use-reconnect-indicator");
const { ConnectionChip } = await import("../../../src/web/components/chat/connection-chip");

const SHOW = 40;
const LOST = 120;
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

let view: Mounted | undefined;
afterEach(async () => { await view?.unmount(); view = undefined; });

let setReconnecting!: (v: boolean) => void;
let retries = 0;
/** Wired the way chat-tab wires it: Retry restarts the stages and reloads the chat. */
function Harness({ initial }: { initial: boolean }) {
  const [reconnecting, update] = useState(initial);
  setReconnecting = update;
  const { stage, restart } = useReconnectIndicator(reconnecting, SHOW, LOST);
  return <ConnectionChip stage={stage} onRetry={() => { restart(); retries++; }} />;
}
const stage = () => view!.container.querySelector("[data-reconnect-stage]")?.getAttribute("data-reconnect-stage") ?? "hidden";

it("shows nothing while connected, and nothing for a reconnect within the grace period", async () => {
  view = await mount(<Harness initial={false} />);
  expect(view.container.innerHTML).toBe("");
  await act(async () => { setReconnecting(true); });
  await wait(SHOW / 2);
  await act(async () => { setReconnecting(false); });
  await wait(LOST);
  expect(stage()).toBe("hidden");
});

it("goes quiet → reconnecting → lost, and Retry starts a fresh attempt", async () => {
  view = await mount(<Harness initial={true} />);
  await wait(SHOW + 20);
  expect(stage()).toBe("reconnecting");
  const reconnecting = view.container.querySelector('[data-reconnect-stage="reconnecting"]')!;
  expect(reconnecting.getAttribute("role")).toBe("status");
  expect(reconnecting.textContent).toContain("Reconnecting");

  await wait(LOST);
  expect(stage()).toBe("lost");
  const lost = view.container.querySelector<HTMLButtonElement>('[data-reconnect-stage="lost"]')!;
  expect(lost.tagName).toBe("BUTTON");
  expect(lost.textContent).toContain("Connection lost");
  expect(lost.textContent).toContain("Offline");
  expect(lost.textContent).toContain("Retry");
  expect(lost.className).toContain("text-error");

  retries = 0;
  await click(lost);
  expect(retries).toBe(1);
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
