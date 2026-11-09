/**
 * A chat socket that reconnects mid-turn gets the running turn back as a `turn_events` replay.
 * The prompt that opened the turn must come out of it still bound to the id it was sent under,
 * or Copy turn link on it waits for a `turn_started` binding that can never match — and a Codex
 * chat always reconnects during its first turn, when the session is renamed.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";
import type { ChatMessage } from "../../../src/types/chat";

installDom();
afterAll(uninstallDom);
const { useChat } = await import("../../../src/web/hooks/use-chat");
const { WsClient } = await import("../../../src/web/lib/ws-client");
const { api } = await import("../../../src/web/lib/api-client");
const { useTurnBindingStore } = await import("../../../src/web/stores/turn-binding-store");
const { CopyTurnLinkButton } = await import("../../../src/web/components/chat/copy-turn-link-button");
const { replayActiveTurn } = await import("../../../src/web/lib/replay-active-turn");

const SID = "cccccccc-0000-4000-8000-000000000002";
const TURN = "dddddddd-1111-4000-8000-000000000002";
let view: Mounted | null = null;
let receive: (event: MessageEvent) => void;
let chat: ReturnType<typeof useChat>;
const spies: Array<{ mockRestore(): void }> = [];

function Probe() {
  chat = useChat(SID, "codex", "proj");
  const last = [...chat.messages].reverse().find((m) => m.role === "user");
  return last ? <CopyTurnLinkButton message={last} projectName="proj" sessionId={SID} providerId="codex" /> : null;
}
const emit = (frame: unknown) => act(async () => receive(new MessageEvent("message", { data: JSON.stringify(frame) })));
const lastUser = () => [...chat.messages].reverse().find((m) => m.role === "user")!;
const button = () => view!.container.querySelector("button")!;

beforeEach(() => {
  useTurnBindingStore.setState({ bindings: {} });
  const send = spyOn(WsClient.prototype, "send").mockImplementation(() => {});
  spies.push(send, spyOn(api, "get").mockResolvedValue([] as never), spyOn(WsClient.prototype, "connect").mockImplementation(() => {}),
    spyOn(WsClient.prototype, "onMessage").mockImplementation((handler) => { receive = handler; return () => {}; }));
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
});

describe("a reconnect mid-turn", () => {
  it("keeps the sent prompt itself, so Copy turn link resolves once its turn starts", async () => {
    view = await mount(<Probe />);
    await act(async () => chat.sendMessage("hi"));
    const sent = lastUser();
    expect(sent.clientId).toBeTruthy();
    await emit({ type: "text", content: "partial answer" });
    // The socket drops and the new one replays the running turn.
    await emit({ type: "turn_events", events: [{ type: "text", content: "partial answer" }], userMessage: "hi", clientMessageId: sent.clientId });
    await act(async () => { await Bun.sleep(30); });
    expect(chat.messages.filter((m) => m.role === "user").length).toBe(1);
    expect(lastUser().id).toBe(sent.id);
    expect(lastUser().clientId).toBe(sent.clientId!);
    // Waiting for the link, then the turn starts (the binding the server keeps for late joiners).
    await click(button());
    await act(async () => { useTurnBindingStore.getState().bind(sent.clientId!, TURN); await Bun.sleep(300); });
    expect(button().getAttribute("aria-label")).toBe("Link ready");
  });

  it("gives the prompt a tab never saw the id the server says it was sent under", async () => {
    view = await mount(<Probe />);
    await emit({ type: "turn_events", events: [{ type: "text", content: "partial" }], userMessage: "from the other tab", clientMessageId: "user-1-1-abc" });
    await act(async () => { await Bun.sleep(30); });
    expect(lastUser().content).toBe("from the other tab");
    expect(lastUser().clientId).toBe("user-1-1-abc");
  });
});

describe("replayActiveTurn", () => {
  const at = "2026-11-04T10:00:00Z";
  const prior: ChatMessage[] = [
    { id: "u0", role: "user", content: "earlier", timestamp: at, turnId: "t0" },
    { id: "a0", role: "assistant", content: "done", timestamp: at, turnId: "t0" },
  ];

  it("clears the running answer and keeps a history copy of the prompt with its turn id", () => {
    const prev: ChatMessage[] = [...prior, { id: "u1", role: "user", content: "now", timestamp: at, turnId: "t1", sdkUuid: "x" },
      { id: "a1", role: "assistant", content: "half", timestamp: at, turnId: "t1" }];
    const out = replayActiveTurn(prev, "now", "c1");
    expect(out.map((m) => m.id)).toEqual(["u0", "a0", "u1"]);
    expect(out[2]).toMatchObject({ turnId: "t1", clientId: "c1" });
  });

  it("leaves a completed earlier turn alone and drops only a streaming answer when the prompt differs", () => {
    const prev: ChatMessage[] = [...prior, { id: "streaming-1", role: "assistant", content: "…", timestamp: at }];
    const out = replayActiveTurn(prev, "new prompt", undefined, () => 5);
    expect(out.map((m) => m.id)).toEqual(["u0", "a0", "user-replay-5"]);
    expect(out[2]!.clientId).toBeUndefined();
  });
});
