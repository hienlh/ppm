/**
 * The chat keeps the error that ended a turn apart from its messages, because the history it
 * reloads at the end of a long turn is the transcript — which has no record of the stop. That
 * reload is what erased the one red line saying a session had hit Max Turns.
 */
import { afterAll, afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { useChat } = await import("../../../src/web/hooks/use-chat");
const { WsClient } = await import("../../../src/web/lib/ws-client");
const { api } = await import("../../../src/web/lib/api-client");

const stop = { message: "Agent reached maximum turn limit.\nReached maximum number of turns (500)", subtype: "error_max_turns", at: 1 };

let chat: ReturnType<typeof useChat>;
let view: Mounted | null = null;
let receive: (event: MessageEvent) => void;
let spies: Array<ReturnType<typeof spyOn>> = [];
function Probe() {
  chat = useChat("session", "claude", "proj");
  return null;
}
async function emit(frame: unknown) {
  await act(async () => receive(new MessageEvent("message", { data: JSON.stringify(frame) })));
}
const greeting = (extra: Record<string, unknown>) => ({ type: "session_state", sessionId: "session", phase: "idle", pendingApproval: null, sessionTitle: null, ...extra });

beforeEach(async () => {
  spies = [
    spyOn(WsClient.prototype, "connect").mockImplementation(() => {}),
    spyOn(WsClient.prototype, "send").mockImplementation(() => {}),
    spyOn(WsClient.prototype, "onMessage").mockImplementation((handler) => { receive = handler; return () => {}; }),
    // The transcript: the turn's last tool result, and nothing about the stop.
    spyOn(api, "get").mockResolvedValue([{ id: "a1", role: "assistant", content: "", events: [{ type: "tool_result", output: "ok" }], timestamp: "2026-10-06T03:48:11Z" }]),
  ];
  view = await mount(<Probe />);
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const spy of spies) spy.mockRestore();
});

it("keeps a stop that arrived with the turn's end through the history reload that follows it", async () => {
  await emit({ type: "phase_changed", phase: "streaming" });
  await emit({ type: "turn_stop", stop });
  await emit({ type: "error", message: stop.message });
  await emit({ type: "done", sessionId: "session", resultSubtype: "error_max_turns" });
  await emit({ type: "phase_changed", phase: "idle" });
  await act(async () => { chat.refetchMessages(); await Bun.sleep(10); });
  expect(chat.messages.some((m) => m.events?.some((e) => e.type === "error"))).toBe(false);
  expect(chat.turnStop).toEqual(stop);
});

it("takes the stop from the greeting, keeps it through a greeting that does not mention it, and drops it for a running turn", async () => {
  await emit(greeting({ turnStop: stop }));
  expect(chat.turnStop).toEqual(stop);
  // A model switch answers with a session_state of its own that carries no turnStop.
  await emit(greeting({ model: "claude-opus-5-5" }));
  expect(chat.turnStop).toEqual(stop);
  await emit(greeting({ phase: "streaming", turnStop: null }));
  expect(chat.turnStop).toBeNull();
});

it("drops the stop when the next message goes out, and when another turn starts", async () => {
  await emit(greeting({ turnStop: stop }));
  await act(async () => chat.sendMessage("Continue from where you left off."));
  expect(chat.turnStop).toBeNull();

  await emit({ type: "phase_changed", phase: "idle" });
  await emit({ type: "turn_stop", stop });
  await emit({ type: "phase_changed", phase: "thinking" });
  expect(chat.turnStop).toBeNull();
});
