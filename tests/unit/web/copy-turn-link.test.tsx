/**
 * Copy turn link names the turn in a fixed order — the message's own id, then the binding
 * `turn_started` made for the id it was sent under, then the session's index by record uuid —
 * and never the newest turn: a message whose turn has not started waits, with a spinner.
 * Also the chat side of it: `turn_started` binds, `message_accepted` replaces the bubble's text,
 * and a jump to a turn finds the tab through a session rename and from a `?turn=` link.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { CopyTurnLinkButton } = await import("../../../src/web/components/chat/copy-turn-link-button");
const { useTurnBindingStore } = await import("../../../src/web/stores/turn-binding-store");
const { useChatJumpStore, requestIsFor, canonicalSessionId } = await import("../../../src/web/stores/chat-jump-store");
const { parseUrlState, requestTurnJumpFromUrl } = await import("../../../src/web/hooks/use-url-sync");
const { useChat } = await import("../../../src/web/hooks/use-chat");
const { WsClient } = await import("../../../src/web/lib/ws-client");
const { api } = await import("../../../src/web/lib/api-client");

const SID = "cccccccc-0000-4000-8000-000000000001";
const TURN = "dddddddd-1111-4000-8000-000000000001";
let view: Mounted | null = null;
let copied: string[];
let get: ReturnType<typeof spyOn>;
// `navigator` is shared by every test file in the process: put its clipboard back afterwards.
const clipboardBefore = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  if (clipboardBefore) Object.defineProperty(navigator, "clipboard", clipboardBefore);
  else delete (navigator as { clipboard?: unknown }).clipboard;
});

beforeEach(() => {
  copied = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  useTurnBindingStore.setState({ bindings: {} });
  useChatJumpStore.setState({ request: null, aliases: {} });
  get = spyOn(api, "get").mockResolvedValue({ turns: [], resolved: { turnId: TURN, n: 1 } } as never);
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  get.mockRestore();
});

const button = () => view!.container.querySelector("button")!;
const expected = `${window.location.origin}/project/my%20proj/chat/claude/${SID}?turn=${TURN}`;
const mountButton = (message: { turnId?: string; clientId?: string; sdkUuid?: string }) =>
  mount(<CopyTurnLinkButton message={message} projectName="my proj" sessionId={SID} providerId="claude" />);

describe("Copy turn link", () => {
  it("copies the message's own turn at once, under the tab's current session id", async () => {
    view = await mountButton({ turnId: TURN, clientId: "c1", sdkUuid: "u1" });
    await click(button());
    await act(async () => { await Bun.sleep(5); });
    expect(copied).toEqual([expected]);
    expect(button().textContent).toContain("Copied");
    expect(get).not.toHaveBeenCalled();
  });

  it("waits with a spinner for the turn its own send opens, ignoring any other binding", async () => {
    view = await mountButton({ clientId: "mine" });
    await click(button());
    // Another message's turn starting says nothing about this one.
    await act(async () => { useTurnBindingStore.getState().bind("someone-else", "eeeeeeee-1111-4000-8000-000000000001"); await Bun.sleep(300); });
    expect(copied).toEqual([]);
    expect(button().querySelector(".animate-spin")).not.toBeNull();
    await act(async () => { useTurnBindingStore.getState().bind("mine", TURN); await Bun.sleep(300); });
    expect(copied).toEqual([expected]);
  });

  it("asks the session's index by record uuid when nothing else names the turn", async () => {
    view = await mountButton({ sdkUuid: "record-uuid" });
    await click(button());
    await act(async () => { await Bun.sleep(20); });
    expect(String(get.mock.calls[0]![0])).toContain(`/chat/sessions/${SID}/turns?providerId=claude&resolve=record-uuid`);
    expect(copied).toEqual([expected]);
  });
});

describe("the chat's side of turn ids", () => {
  let receive: (event: MessageEvent) => void;
  let chat: ReturnType<typeof useChat>;
  const spies: Array<{ mockRestore(): void }> = [];
  function Probe() { chat = useChat("session", "claude", "proj"); return null; }
  const emit = (frame: unknown) => act(async () => receive(new MessageEvent("message", { data: JSON.stringify(frame) })));
  afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

  it("binds turn_started to the id the message was sent under, and adopts the acked text", async () => {
    get.mockResolvedValue([] as never);
    const send = spyOn(WsClient.prototype, "send").mockImplementation(() => {});
    spies.push(send, spyOn(WsClient.prototype, "connect").mockImplementation(() => {}),
      spyOn(WsClient.prototype, "onMessage").mockImplementation((handler) => { receive = handler; return () => {}; }));
    view = await mount(<Probe />);
    await act(async () => chat.sendMessage("hi"));
    const clientMessageId = JSON.parse(String(send.mock.calls.at(-1)![0])).clientMessageId as string;
    expect(chat.messages.at(-1)!.clientId).toBe(clientMessageId);
    await emit({ type: "turn_started", turnId: TURN, clientMessageId });
    expect(useTurnBindingStore.getState().bindings[clientMessageId]).toBe(TURN);
    expect(chat.currentTurnId).toBe(TURN);
    await emit({ type: "message_accepted", clientMessageId, content: "hi (as stored)" });
    expect(chat.messages.at(-1)!.content).toBe("hi (as stored)");
  });
});

describe("jumping to a turn", () => {
  it("finds the tab through a session rename", () => {
    useChatJumpStore.getState().noteRename("old-id-0001", SID);
    const { aliases } = useChatJumpStore.getState();
    expect(canonicalSessionId("old-id-0001")).toBe(SID);
    expect(requestIsFor({ sessionId: "old-id-0001", turnId: TURN, at: 0 }, SID, aliases)).toBe(true);
    expect(requestIsFor({ sessionId: "other-id-0001", turnId: TURN, at: 0 }, SID, aliases)).toBe(false);
  });

  it("reads ?turn= from a chat URL, asks for the jump, and takes it off the address", () => {
    const state = parseUrlState({ pathname: `/project/p/chat/claude/${SID}`, search: `?turn=${TURN}` });
    expect(state.turnId).toBe(TURN);
    expect(parseUrlState({ pathname: `/project/p/chat/claude/${SID}`, search: "?turn=../../x" }).turnId).toBeUndefined();
    window.history.replaceState(null, "", `/project/p/chat/claude/${SID}?turn=${TURN}`);
    requestTurnJumpFromUrl(state, "p");
    expect(useChatJumpStore.getState().request).toMatchObject({ sessionId: SID, turnId: TURN });
    expect(window.location.search).toBe("");
  });
});
