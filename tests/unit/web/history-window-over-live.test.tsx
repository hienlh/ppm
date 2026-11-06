/**
 * What the history window does about the live chat it covers.
 *
 * - An approval or a question the agent waits on is shown over the window, above the composer, and
 *   can be answered there; the hidden live list does not hold a second approval card.
 * - A message sent from this tab leaves the window for the live list; one from another device does not.
 * - "Loading earlier turns" floats over the window instead of pushing its rows down.
 * - On a phone the Back to latest pill sits above every bar under the transcript, a 44 px target outside
 *   the scroller, with the waiting block above it.
 * - Focus moves into the window when it opens.
 * - A Review tab jump to a call in a turn the live list has not loaded opens the window on that turn.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, installGlobal, mount, click, type Mounted } from "../../helpers/react-dom";
import type { ChatMessage } from "../../../src/types/chat";

installDom();
installGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
installGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
// happy-dom has no CSS.escape; the ids here need no escaping.
if (!(globalThis as { CSS?: unknown }).CSS) installGlobal("CSS", { escape: (v: string) => v });
const requests: string[] = [];
let answer: (url: URL) => { status: number; body: unknown } = () => ({ status: 500, body: { ok: false, error: "unset" } });
installGlobal("fetch", async (input: string) => {
  const url = new URL(input, "http://localhost");
  requests.push(url.pathname + url.search);
  const { status, body } = answer(url);
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
});

const { MessageList } = await import("../../../src/web/components/chat/message-list");
const { ChatHistoryWindow } = await import("../../../src/web/components/chat/chat-history-window");
const { useChatJumpStore } = await import("../../../src/web/stores/chat-jump-store");

const SID = "s1";
const T = (n: number) => `ffffffff-1111-4000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-11-04T10:00:00Z";
const turn = (n: number): ChatMessage[] => [
  { id: `u${n}`, role: "user", content: `ask ${n}`, timestamp: at, turnId: T(n), turnN: n },
  { id: `a${n}`, role: "assistant", content: `answer ${n}`, timestamp: at, turnId: T(n), turnN: n },
];
const turns = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => turn(from + i)).flat();
const page = (from: number, to: number) => ({
  status: 200,
  body: { ok: true, data: {
    sessionId: SID, messages: turns(from, to), hasOlder: from > 1, hasNewer: to < 6, latestTurnId: T(6),
    turns: Array.from({ length: to - from + 1 }, (_, i) => ({ turnId: T(from + i), n: from + i, status: "complete" })),
  } },
});

const proto = window.HTMLElement.prototype;
const heightBefore = Object.getOwnPropertyDescriptor(proto, "clientHeight");
const widthBefore = window.innerWidth;
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
  answer = () => page(1, 5);
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: widthBefore });
});

type Approval = { requestId: string; tool: string; input: unknown } | null;
const responses: Array<[string, boolean]> = [];
const list = (messages: ChatMessage[], approval: Approval = null) => (
  <MessageList messages={messages} sessionId={SID} providerId="claude" projectName="proj" pendingApproval={approval}
    onApprovalResponse={(id, ok) => responses.push([id, ok])} isStreaming={false} />
);
const wait = (ms = 30) => act(async () => { await Bun.sleep(ms); });
const historyWindow = () => view!.container.querySelector<HTMLElement>("[data-history-window]");
const liveScroller = () => [...view!.container.querySelectorAll<HTMLElement>(".overflow-y-auto")].find((el) => !el.closest("[data-history-window]") && !el.closest("[data-window-pending]"))!;
const openWindowOn = async (n: number) => {
  await act(async () => { useChatJumpStore.getState().jump({ sessionId: SID, turnId: T(n) }); });
  await wait();
  expect(historyWindow()).not.toBeNull();
};
const allow = { requestId: "r1", tool: "Bash", input: { command: "ls" } };

describe("the history window over the live chat", () => {
  it("shows a pending approval above the composer, answerable, and not a second copy in the hidden list", async () => {
    view = await mount(list(turns(5, 6)));
    await openWindowOn(2);
    await view.rerender(list(turns(5, 6), allow));
    const block = view.container.querySelector<HTMLElement>("[data-window-pending]")!;
    expect(block).not.toBeNull();
    expect(block.closest("[inert]")).toBeNull();
    expect(historyWindow()!.contains(block)).toBe(false);
    expect(liveScroller().textContent).not.toContain("Tool Approval Required");
    const button = [...block.querySelectorAll("button")].find((b) => b.textContent === "Allow")!;
    await click(button);
    expect(responses.at(-1)).toEqual(["r1", true]);
    // Back in the live list the card is drawn where it always was, at the end of the transcript.
    await click([...historyWindow()!.querySelectorAll("button")].find((b) => b.textContent?.includes("Back to latest"))!);
    await wait();
    expect(view.container.querySelector("[data-window-pending]")).toBeNull();
    expect(liveScroller().textContent).toContain("Tool Approval Required");
  });

  it("shows an open question from the running turn above the composer", async () => {
    const asking: ChatMessage = { id: "a6q", role: "assistant", content: "", timestamp: at, events: [
      { type: "tool_use", tool: "RequestUserInput", toolUseId: "item-1", input: { questions: [{ question: "Which branch?", options: [{ label: "main" }] }] } },
    ] };
    view = await mount(list([...turns(5, 6), asking]));
    await openWindowOn(2);
    const block = view.container.querySelector<HTMLElement>("[data-window-pending]")!;
    expect(block.textContent).toContain("Which branch?");
  });

  it("leaves for the live list when this tab sends a message, and stays for one from another device", async () => {
    view = await mount(list(turns(5, 6)));
    await openWindowOn(2);
    const remote: ChatMessage = { id: "user-remote-1", clientId: "other", role: "user", content: "from the phone", timestamp: at };
    await view.rerender(list([...turns(5, 6), remote]));
    await wait();
    expect(historyWindow()).not.toBeNull();
    const mine: ChatMessage = { id: "user-1-1-abc", clientId: "user-1-1-abc", role: "user", content: "next question", timestamp: at };
    await view.rerender(list([...turns(5, 6), remote, mine]));
    await wait();
    expect(historyWindow()).toBeNull();
    expect(liveScroller().style.visibility).toBe("");
  });

  it("floats Loading earlier turns over the window, outside the scrolled rows, and takes focus on open", async () => {
    const data = page(3, 5).body.data;
    const windowView = {
      mode: "window" as const, turns: data.turns as Array<{ turnId: string; n: number; status: "complete" }>, messages: data.messages,
      hasOlder: true, hasNewer: true, loadingOlder: true, loadingNewer: false, targetTurnId: T(4), landing: 1, latestTurnId: T(6), loadError: null,
    };
    const noop = () => {};
    view = await mount(
      <div className="relative">
        <ChatHistoryWindow view={windowView} controls={{ loadOlder: noop, loadNewer: noop, retry: noop }} canMerge={false}
          onMerge={() => false} onBackToLatest={noop} liveActivity={false} sessionId={SID} providerId="claude" />
      </div>,
    );
    const scroller = historyWindow()!.querySelector<HTMLElement>("[aria-label='Earlier turns']")!;
    const notice = historyWindow()!.querySelector<HTMLElement>("[aria-label='Loading earlier turns']")!;
    expect(notice).not.toBeNull();
    // Out of the rows' flow: appearing cannot push the row being read down by its height.
    expect(scroller.contains(notice)).toBe(false);
    expect(notice.parentElement!.className).toContain("absolute");
    expect(document.activeElement).toBe(scroller);
  });

  it("keeps the pill above the bars under the transcript on a phone, a 44 px target outside the scroller", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    // The chat tab's column: the transcript, then the bars, then the composer (see the source-order test below).
    const column = (approval: Approval = null) => (
      <div className="flex flex-col">
        {list(turns(5, 6), approval)}
        <div data-bars="">files changed</div>
        <div data-composer="" />
      </div>
    );
    view = await mount(column());
    await openWindowOn(2);
    const pill = view.container.querySelector<HTMLElement>("[data-back-to-latest]")!;
    expect(view.container.querySelectorAll("[data-back-to-latest]").length).toBe(1);
    // Inside the window, which covers the transcript only, so above the first bar in the column.
    expect(historyWindow()!.contains(pill)).toBe(true);
    expect(historyWindow()!.querySelector("[aria-label='Earlier turns']")!.contains(pill)).toBe(false);
    const bars = view.container.querySelector("[data-bars]")!;
    expect(bars.contains(pill)).toBe(false);
    expect(pill.compareDocumentPosition(bars) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pill.className).toContain("bottom-3");
    expect(pill.querySelector("button")!.className).toContain("min-h-[44px]");
    // The waiting block sits above the pill rather than under it.
    await view.rerender(column(allow));
    expect(view.container.querySelector("[data-window-pending]")!.className).toContain("bottom-[4.25rem]");
  });

  it("stacks every bar under the conversation below the transcript the window covers", async () => {
    const source = await Bun.file(new URL("../../../src/web/components/chat/chat-tab.tsx", import.meta.url)).text();
    const at = (tag: string) => {
      const i = source.indexOf(`<${tag}`);
      expect(i).toBeGreaterThan(-1);
      return i;
    };
    const transcript = at("MessageList");
    for (const bar of ["RunningAgentsBar", "TurnStopBar", "McpSignInBar", "SessionChangesBar", "MessageInput"]) {
      expect(at(bar)).toBeGreaterThan(transcript);
    }
    // The pill is drawn where the window is; portalling it next to the composer put it over the bars.
    const windowSource = await Bun.file(new URL("../../../src/web/components/chat/chat-history-window.tsx", import.meta.url)).text();
    expect(windowSource).not.toContain("createPortal");
  });

  it("opens the window on the turn a Review tab jump names when its call is not loaded", async () => {
    answer = () => page(1, 4);
    view = await mount(list(turns(5, 6)));
    await act(async () => { useChatJumpStore.getState().jump({ sessionId: SID, toolUseId: "toolu_old", messageId: "u2", turnId: T(2) }); });
    await wait(400);
    expect(requests.some((r) => r.includes(`turn=${T(2)}`))).toBe(true);
    expect(historyWindow()?.querySelector(`[data-turn-start="${T(2)}"]`)).not.toBeNull();
    expect(useChatJumpStore.getState().request).toBeNull();
  });
});
