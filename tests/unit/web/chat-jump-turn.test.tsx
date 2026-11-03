/**
 * Jumping to a turn, in both containers.
 *
 * - A turn the live list has drawn is landed on there: no fetch, no window.
 * - A turn it has not loaded is read from the turn index into the history window, laid over the
 *   live list, which stays mounted but hidden (`visibility`, never `display: none`).
 * - In window mode every jump goes to the window; the hidden live list is never the target.
 * - A turn that is gone leaves the reader where they were.
 * - "Back to latest" and the merge at the bottom hand the reader back to the live list.
 *
 * happy-dom has no layout and no IntersectionObserver, so every row sits at 0 and the bottom
 * sentinel is reported in range by hand, the event the window waits for.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, installGlobal, mount, click, type Mounted } from "../../helpers/react-dom";
import type { ChatMessage } from "../../../src/types/chat";

installDom();
installGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
interface FakeIo { cb: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void; observed: Element[]; disconnected: boolean }
const observers: FakeIo[] = [];
installGlobal("IntersectionObserver", class {
  private self: FakeIo;
  constructor(cb: FakeIo["cb"]) { this.self = { cb, observed: [], disconnected: false }; observers.push(this.self); }
  observe(target: Element) { this.self.observed.push(target); }
  unobserve() {}
  disconnect() { this.self.disconnected = true; }
});
const requests: string[] = [];
/** What the turn-window route answers, by the turn asked about. */
let answer: (url: URL) => { status: number; body: unknown } = () => ({ status: 500, body: { ok: false, error: "unset" } });
installGlobal("fetch", async (input: string) => {
  const url = new URL(input, "http://localhost");
  requests.push(url.pathname + url.search);
  const { status, body } = answer(url);
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
});

const { MessageList } = await import("../../../src/web/components/chat/message-list");
const { useChatJumpStore } = await import("../../../src/web/stores/chat-jump-store");

const SID = "s1";
const T = (n: number) => `eeeeeeee-1111-4000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-11-04T10:00:00Z";
const turn = (n: number): ChatMessage[] => [
  { id: `u${n}`, role: "user", content: `ask ${n}`, timestamp: at, turnId: T(n), turnN: n },
  { id: `a${n}`, role: "assistant", content: `answer ${n}`, timestamp: at, turnId: T(n), turnN: n },
];
const turns = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => turn(from + i)).flat();
/** The window route's answer for turns `from`–`to` of a six-turn session. */
const windowPage = (from: number, to: number) => ({
  status: 200,
  body: {
    ok: true,
    data: {
      sessionId: SID,
      turns: Array.from({ length: to - from + 1 }, (_, i) => ({ turnId: T(from + i), n: from + i, status: "complete" })),
      messages: turns(from, to),
      hasOlder: from > 1,
      hasNewer: to < 6,
      latestTurnId: T(6),
    },
  },
});

const proto = window.HTMLElement.prototype;
const heightBefore = Object.getOwnPropertyDescriptor(proto, "clientHeight");
beforeAll(() => { Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 600 }); });
afterAll(() => {
  if (heightBefore) Object.defineProperty(proto, "clientHeight", heightBefore);
  else delete (proto as { clientHeight?: number }).clientHeight;
  uninstallDom();
});
let view: Mounted | null = null;
beforeEach(() => {
  useChatJumpStore.setState({ request: null, aliases: {} });
  requests.length = 0;
  observers.length = 0;
});
afterEach(async () => { await view?.unmount(); view = null; });

const list = (messages: ChatMessage[], isStreaming = false) => (
  <MessageList messages={messages} sessionId={SID} providerId="claude" projectName="proj" pendingApproval={null}
    onApprovalResponse={() => {}} isStreaming={isStreaming} onFork={() => {}} onEdit={() => {}} />
);
const wait = (ms = 30) => act(async () => { await Bun.sleep(ms); });
const jump = (turnId: string) => act(async () => { useChatJumpStore.getState().jump({ sessionId: SID, turnId }); });
const historyWindow = () => view!.container.querySelector<HTMLElement>("[data-history-window]");
const liveScroller = () => [...view!.container.querySelectorAll<HTMLElement>(".overflow-y-auto")].find((el) => !el.closest("[data-history-window]"))!;
const inWindow = (turnId: string) => historyWindow()?.querySelector<HTMLElement>(`[data-turn-start="${turnId}"]`) ?? null;
const flashed = (el: HTMLElement | null) => !!el && el.className.includes("ring-primary/40");
const windowRequests = () => requests.filter((r) => r.includes("/turn-window"));
/** Report the window's bottom sentinel in range, as the browser would on reaching the end. */
const reachBottom = () => act(async () => {
  for (const io of observers.filter((o) => !o.disconnected)) {
    const bottom = io.observed[io.observed.length - 1];
    if (bottom && historyWindow()?.contains(bottom)) io.cb([{ target: bottom, isIntersecting: true }]);
  }
});

describe("jumping to a turn", () => {
  it("lands in the live list when the turn is drawn there, with no fetch and no window", async () => {
    view = await mount(list(turns(3, 6)));
    await jump(T(4));
    await wait();
    expect(flashed(view.container.querySelector(`[data-turn-start="${T(4)}"]`))).toBe(true);
    expect(windowRequests()).toEqual([]);
    expect(historyWindow()).toBeNull();
    expect(useChatJumpStore.getState().request).toBeNull();
  });

  it("opens the history window around a turn the live list has not loaded, over the hidden live list", async () => {
    answer = () => windowPage(1, 5);
    view = await mount(list(turns(5, 6)));
    await jump(T(2));
    await wait();
    expect(windowRequests()).toEqual([`/api/project/proj/chat/sessions/${SID}/turn-window?providerId=claude&turn=${T(2)}`]);
    expect(historyWindow()).not.toBeNull();
    expect(flashed(inWindow(T(2)))).toBe(true);
    // The live list is still there, laid out, only hidden.
    const live = liveScroller();
    expect(live.style.visibility).toBe("hidden");
    expect(live.style.display).not.toBe("none");
    expect(live.querySelector(`[data-turn-start="${T(5)}"]`)).not.toBeNull();
    // Window rows offer Copy only: no Reply, Edit or Fork.
    const labels = [...historyWindow()!.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(labels.some((l) => /Edit|Fork|Reply/.test(l))).toBe(false);
    expect(historyWindow()!.textContent).toContain("Viewing turn");
    expect(useChatJumpStore.getState().request).toBeNull();
  });

  it("in window mode sends every jump to the window: one it holds is landed on, any other refetched", async () => {
    answer = () => windowPage(1, 5);
    view = await mount(list(turns(5, 6)));
    await jump(T(2));
    await wait();
    await jump(T(4));
    await wait();
    expect(flashed(inWindow(T(4)))).toBe(true);
    expect(windowRequests().length).toBe(1);
    // Turn 6 is in the hidden live list, but the window is what the reader sees.
    answer = () => windowPage(4, 6);
    await jump(T(6));
    await wait();
    expect(windowRequests().length).toBe(2);
    expect(windowRequests()[1]).toContain(`turn=${T(6)}`);
    expect(flashed(inWindow(T(6)))).toBe(true);
  });

  it("stays where it is when the turn is gone", async () => {
    answer = () => ({ status: 410, body: { ok: false, error: "That turn was rolled back", code: "rolled_back" } });
    view = await mount(list(turns(5, 6)));
    await jump(T(2));
    await wait();
    expect(historyWindow()).toBeNull();
    expect(liveScroller().style.visibility).toBe("");
    expect(useChatJumpStore.getState().request).toBeNull();
  });

  it("Back to latest returns to the live list", async () => {
    answer = () => windowPage(1, 5);
    view = await mount(list(turns(5, 6)));
    await jump(T(2));
    await wait();
    const pill = [...historyWindow()!.querySelectorAll("button")].find((b) => b.textContent?.includes("Back to latest"))!;
    await click(pill);
    await wait();
    expect(historyWindow()).toBeNull();
    expect(liveScroller().style.visibility).toBe("");
  });

  it("merges back at the bottom only once the live list holds the place and the window's last turn", async () => {
    answer = (url) => (url.searchParams.get("afterTurn") ? windowPage(6, 6) : windowPage(1, 5));
    view = await mount(list(turns(4, 6)));
    await jump(T(2));
    await wait();
    // Turn 2 is pinned and the live list does not have it: reaching the bottom stays in the window.
    await reachBottom();
    await wait();
    expect(historyWindow()).not.toBeNull();
    // The reader scrolls; the turn at the top (every row is at 0 here: the last start) is one the
    // live list holds, as is turn 5, the window's last.
    const scroller = historyWindow()!.querySelector<HTMLElement>(".overflow-y-auto")!;
    await act(async () => { scroller.dispatchEvent(new window.Event("wheel")); });
    await reachBottom();
    await wait();
    expect(historyWindow()).toBeNull();
  });

  it("does not merge while the live list is streaming the window's last turn", async () => {
    answer = () => windowPage(2, 6);
    view = await mount(list(turns(5, 6), true));
    await jump(T(3));
    await wait();
    const scroller = historyWindow()!.querySelector<HTMLElement>(".overflow-y-auto")!;
    await act(async () => { scroller.dispatchEvent(new window.Event("wheel")); });
    await reachBottom();
    await wait();
    expect(historyWindow()).not.toBeNull();
    // The streamed turn ends and the list is refetched: now it may.
    await view.rerender(list(turns(5, 6), false));
    await wait();
    expect(historyWindow()).toBeNull();
  });
});
