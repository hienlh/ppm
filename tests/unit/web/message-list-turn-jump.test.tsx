/**
 * A turn reference or a `?turn=` link asks the chat to show a turn: the list finds the turn's
 * first message (`data-turn-start`), scrolls to it and flashes it. The wait for it to appear is
 * counted from when the chat is on screen with its history in, so a tab that took a while to
 * open — another project's, over a slow tunnel — does not drop the jump before it could look.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, installGlobal, mount, type Mounted } from "../../helpers/react-dom";
import type { ChatMessage } from "../../../src/types/chat";

installDom();
installGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
const { MessageList } = await import("../../../src/web/components/chat/message-list");
const { useChatJumpStore } = await import("../../../src/web/stores/chat-jump-store");

const SID = "s1";
const T1 = "dddddddd-1111-4000-8000-000000000001";
const T2 = "dddddddd-1111-4000-8000-000000000002";
const timestamp = "2026-10-01T10:00:00Z";
const first: ChatMessage[] = [
  { id: "u1", role: "user", content: "first ask", timestamp, turnId: T1 },
  { id: "a1", role: "assistant", content: "first answer", timestamp, turnId: T1 },
];
const second: ChatMessage[] = [
  { id: "u2", role: "user", content: "second ask", timestamp, turnId: T2 },
  { id: "a2", role: "assistant", content: "second answer", timestamp, turnId: T2 },
];
let view: Mounted | null = null;

// happy-dom has no layout, and a list with no height is a hidden tab, which a jump waits out.
const proto = window.HTMLElement.prototype;
const heightBefore = Object.getOwnPropertyDescriptor(proto, "clientHeight");
beforeAll(() => { Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 600 }); });
afterAll(() => {
  if (heightBefore) Object.defineProperty(proto, "clientHeight", heightBefore);
  else delete (proto as { clientHeight?: number }).clientHeight;
  uninstallDom();
});
beforeEach(() => { useChatJumpStore.setState({ request: null, aliases: {} }); });
afterEach(async () => { await view?.unmount(); view = null; });

const list = (messages: ChatMessage[], messagesLoading = false) => (
  <MessageList messages={messages} messagesLoading={messagesLoading} sessionId={SID} providerId="claude" pendingApproval={null} onApprovalResponse={() => {}} isStreaming={false} />
);
const turnStart = (turnId: string) => view!.container.querySelector<HTMLElement>(`[data-turn-start="${turnId}"]`);
const wait = (ms: number) => act(async () => { await Bun.sleep(ms); });

describe("jumping to a turn in the message list", () => {
  it("scrolls to the turn's first message and flashes it", async () => {
    view = await mount(list([...first, ...second]));
    expect(turnStart(T2)).not.toBeNull();
    expect(turnStart(T2)!.dataset.msgIndex).toBe("2");
    await act(async () => { useChatJumpStore.getState().jump({ sessionId: SID, turnId: T2 }); });
    await wait(50);
    expect(turnStart(T2)!.className).toContain("ring-primary/40");
    expect(turnStart(T1)!.className).not.toContain("ring-primary/40");
    expect(useChatJumpStore.getState().request).toBeNull();
  });

  it("counts its wait from when the history is in, not from when it was asked", async () => {
    // Asked 20 s ago, longer than the wait itself: the tab spent that long opening and loading.
    useChatJumpStore.setState({ request: { sessionId: SID, turnId: T2, at: Date.now() - 20_000 } });
    view = await mount(list([], true));
    await view.rerender(list(first));
    await wait(200);
    // Not on screen yet, and still waited for.
    expect(useChatJumpStore.getState().request).not.toBeNull();
    await view.rerender(list([...first, ...second]));
    await wait(200);
    expect(turnStart(T2)!.className).toContain("ring-primary/40");
    expect(useChatJumpStore.getState().request).toBeNull();
  });

  it("gives up on a request nothing could take up for a minute", async () => {
    useChatJumpStore.setState({ request: { sessionId: SID, turnId: T2, at: Date.now() - 61_000 } });
    view = await mount(list(first));
    await wait(50);
    expect(useChatJumpStore.getState().request).toBeNull();
  });
});
