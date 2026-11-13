/**
 * `session_state.boundPermissionMode` is the clamped mode ("default"/"acceptEdits") an
 * extension-bound, policy-enforced chat really runs in (`boundPermissionModeFor` in
 * `src/server/ws/chat.ts`). The composer must read it from here rather than keep showing
 * whatever permission mode was locally selected before the chat was bound.
 */
import { afterAll, afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { useChat } = await import("../../../src/web/hooks/use-chat");
const { WsClient } = await import("../../../src/web/lib/ws-client");
const { api } = await import("../../../src/web/lib/api-client");

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
const greeting = (extra: Record<string, unknown>) => ({
  type: "session_state", sessionId: "session", phase: "idle", pendingApproval: null, sessionTitle: null,
  boundPermissionMode: null, ...extra,
});

beforeEach(async () => {
  spies = [
    spyOn(WsClient.prototype, "connect").mockImplementation(() => {}),
    spyOn(WsClient.prototype, "send").mockImplementation(() => {}),
    spyOn(WsClient.prototype, "onMessage").mockImplementation((handler) => { receive = handler; return () => {}; }),
    spyOn(api, "get").mockResolvedValue([] as never),
  ];
  view = await mount(<Probe />);
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const spy of spies) spy.mockRestore();
});

it("is null for an ordinary (unbound) chat", async () => {
  await emit(greeting({}));
  expect(chat.boundPermissionMode).toBeNull();
});

it("takes the clamped mode from the greeting for a policy-bound chat", async () => {
  await emit(greeting({ boundPermissionMode: "acceptEdits" }));
  expect(chat.boundPermissionMode).toBe("acceptEdits");
});

it("updates when a later greeting reports a different clamped mode (bind/unbind mid-session)", async () => {
  await emit(greeting({ boundPermissionMode: "default" }));
  expect(chat.boundPermissionMode).toBe("default");
  await emit(greeting({ boundPermissionMode: "acceptEdits" }));
  expect(chat.boundPermissionMode).toBe("acceptEdits");
  // The extension's binding was removed, or its tool policy cleared: back to an ordinary chat.
  await emit(greeting({ boundPermissionMode: null }));
  expect(chat.boundPermissionMode).toBeNull();
});
