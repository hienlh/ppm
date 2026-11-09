/**
 * The chat holds what overrides the effort pick as the server last said it: from a greeting that
 * carries it, from the `effort_status` a turn's start sends, and for this session only.
 */
import { afterAll, afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { act, useState } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";
import type { EffortStatus } from "../../../src/shared/effort-status";

installDom();
afterAll(uninstallDom);
const { useChat } = await import("../../../src/web/hooks/use-chat");
const { WsClient } = await import("../../../src/web/lib/ws-client");
const { api } = await import("../../../src/web/lib/api-client");

const FROM_FILES: EffortStatus = { env: { value: "max", source: "userSettings" } };
const FROM_CLI: EffortStatus = { ...FROM_FILES, observed: { requested: "high", applied: "max" } };

let chat: ReturnType<typeof useChat>;
let switchTo: (sessionId: string) => void;
let view: Mounted | null = null;
let receive: (event: MessageEvent) => void;
let spies: Array<ReturnType<typeof spyOn>> = [];
function Probe() {
  const [sessionId, setSessionId] = useState("session");
  switchTo = setSessionId;
  chat = useChat(sessionId, "claude", "proj");
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
    spyOn(api, "get").mockResolvedValue({ messages: [], versionMap: {} }),
  ];
  view = await mount(<Probe />);
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const spy of spies) spy.mockRestore();
});

it("is undefined until the server has said, then takes the greeting's answer", async () => {
  expect(chat.effortStatus).toBeUndefined();
  await emit(greeting({ effort: "high", effortStatus: FROM_FILES }));
  expect(chat.effortStatus).toEqual(FROM_FILES);
});

it("follows the CLI's answer at a turn's start, and a greeting without the field leaves it alone", async () => {
  await emit(greeting({ effort: "high", effortStatus: FROM_FILES }));
  await emit({ type: "effort_status", status: FROM_CLI });
  expect(chat.effortStatus).toEqual(FROM_CLI);
  // The greeting a new socket gets first carries no effort fields at all.
  await emit(greeting({ model: "claude-opus-5-5" }));
  expect(chat.effortStatus).toEqual(FROM_CLI);
  // A provider nothing overrides is told as null, which is an answer, not "not yet".
  await emit(greeting({ effort: "high", effortStatus: null }));
  expect(chat.effortStatus).toBeNull();
});

it("forgets one session's answer when the tab moves to another", async () => {
  await emit(greeting({ effort: "high", effortStatus: FROM_CLI }));
  await act(async () => switchTo("other-session"));
  expect(chat.effortStatus).toBeUndefined();
});
