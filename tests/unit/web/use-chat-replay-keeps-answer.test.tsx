/**
 * A chat socket that reconnects mid-turn gets the running turn back as a `turn_events` replay,
 * which the page rebuilds. The answer already on screen must stay there until the rebuilt one
 * replaces it: taking it off first left the list ending on the reader's own message for as long
 * as the rebuild took, which at the bottom of a chat reads as a jump back to the previous message.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";
import type { ChatMessage } from "../../../src/types/chat";

installDom();
afterAll(uninstallDom);
const { useChat } = await import("../../../src/web/hooks/use-chat");
const { WsClient } = await import("../../../src/web/lib/ws-client");
const { api } = await import("../../../src/web/lib/api-client");
const { commitReplayedTurn, replayReplacedIds } = await import("../../../src/web/lib/replay-active-turn");

const SID = "cccccccc-0000-4000-8000-000000000003";
let view: Mounted | null = null;
let receive: (event: MessageEvent) => void;
let chat: ReturnType<typeof useChat>;
/** Every list the hook rendered, in order. */
let renders: ChatMessage[][] = [];
const spies: Array<{ mockRestore(): void }> = [];

function Probe() {
  chat = useChat(SID, "claude", "proj");
  renders.push(chat.messages);
  return null;
}
const emit = (frame: unknown) => act(async () => receive(new MessageEvent("message", { data: JSON.stringify(frame) })));
const settle = (ms = 200) => act(async () => { await Bun.sleep(ms); });
const assistants = () => chat.messages.filter((m) => m.role === "assistant");
const last = () => chat.messages[chat.messages.length - 1]!;
/** Renders, after the answer was first drawn, whose list ended on the prompt instead. */
const rendersEndingOnPrompt = (prompt: string) => {
  let shown = false, gone = 0;
  for (const list of renders) {
    const end = list[list.length - 1];
    if (end?.role === "assistant") shown = true;
    else if (shown && end?.role === "user" && end.content === prompt) gone++;
  }
  return gone;
};
const texts = (parts: string[]) => parts.map((content) => ({ type: "text", content }));

beforeEach(() => {
  renders = [];
  spies.push(spyOn(WsClient.prototype, "send").mockImplementation(() => {}), spyOn(api, "get").mockResolvedValue([] as never),
    spyOn(WsClient.prototype, "connect").mockImplementation(() => {}),
    spyOn(WsClient.prototype, "onMessage").mockImplementation((handler) => { receive = handler; return () => {}; }));
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
});

async function answerOnScreen(parts: string[]) {
  view = await mount(<Probe />);
  await act(async () => chat.sendMessage("hi"));
  await emit({ type: "phase_changed", phase: "streaming" });
  for (const ev of texts(parts)) await emit(ev);
  await settle();
  expect(last().role).toBe("assistant");
  expect(last().content).toBe(parts.join(""));
}

describe("a reconnect mid-turn", () => {
  it("keeps the answer on screen until the rebuilt one replaces it", async () => {
    await answerOnScreen(["partial ", "answer"]);
    // A snapshot of several hundred events takes several frames to rebuild.
    const replayed = texts(["partial ", "answer", ...Array.from({ length: 300 }, (_, i) => ` w${i}`)]);
    await emit({ type: "turn_events", events: replayed, userMessage: "hi", streamSeq: replayed.length });
    expect(last().role).toBe("assistant");
    expect(last().content).toBe("partial answer");
    await settle();
    expect(assistants().length).toBe(1);
    expect(last().content).toStartWith("partial answer w0 w1");
    expect(last().content).toEndWith(" w299");
    expect(rendersEndingOnPrompt("hi")).toBe(0);
  });

  it("carries on from the rebuilt answer with the live frames that follow it", async () => {
    await answerOnScreen(["one"]);
    await emit({ type: "turn_events", events: texts(["one", " two"]), userMessage: "hi", streamSeq: 2 });
    await settle(50);
    await emit({ type: "text", content: " three", streamSeq: 3 });
    await settle();
    expect(assistants().length).toBe(1);
    expect(last().content).toBe("one two three");
    expect(rendersEndingOnPrompt("hi")).toBe(0);
  });

  it("keeps what is shown when a truncated replay rebuilds less of the turn", async () => {
    await answerOnScreen(["a", "b", "c", "d", "e"]);
    // The server buffers only a turn's first events; the replay says so.
    await emit({ type: "turn_events", events: texts(["a", "b"]), userMessage: "hi", streamSeq: 9, truncated: true });
    await settle(50);
    expect(last().content).toBe("abcde");
    await emit({ type: "text", content: "f", streamSeq: 10 });
    await settle();
    expect(assistants().length).toBe(1);
    expect(last().content).toBe("abcdef");
    expect(rendersEndingOnPrompt("hi")).toBe(0);
  });

  it("nests a child of an Agent card into the rebuilt card", async () => {
    view = await mount(<Probe />);
    await act(async () => chat.sendMessage("hi"));
    await emit({ type: "phase_changed", phase: "streaming" });
    await emit({ type: "tool_use", tool: "Agent", input: { description: "scout" }, toolUseId: "ag1" });
    await settle();
    await emit({ type: "turn_events", userMessage: "hi", streamSeq: 2, events: [
      { type: "tool_use", tool: "Agent", input: { description: "scout" }, toolUseId: "ag1" },
      { type: "tool_use", tool: "Read", input: { file_path: "a.ts" }, toolUseId: "r1", parentToolUseId: "ag1" },
    ] });
    await settle();
    expect(assistants().length).toBe(1);
    // A card counts its child steps by id (`applyChildToParent`).
    const card = last().events?.[0] as { toolUseId?: string; stepIds?: string[] };
    expect(card.toolUseId).toBe("ag1");
    expect(card.stepIds).toEqual(["r1"]);
  });

  it("draws an error raised before the answer had anything on its own, as live", async () => {
    view = await mount(<Probe />);
    await act(async () => chat.sendMessage("hi"));
    await emit({ type: "phase_changed", phase: "streaming" });
    await emit({ type: "turn_events", userMessage: "hi", streamSeq: 2, events: [
      { type: "error", message: "overloaded" },
      { type: "text", content: "retried fine" },
    ] });
    await settle();
    expect(chat.messages.slice(-3).map((m) => m.role)).toEqual(["user", "system", "assistant"]);
    expect(last().content).toBe("retried fine");
  });
});

describe("a turn streamed without a reconnect", () => {
  it("still draws the answer as it is written", async () => {
    await answerOnScreen(["one"]);
    await emit({ type: "text", content: " two" });
    await settle();
    expect(last().content).toBe("one two");
    await emit({ type: "text", content: " three" });
    await settle();
    expect(last().content).toBe("one two three");
    // Three separate drawings of the growing answer, not one at the end.
    const drawn = new Set(renders.map((list) => list[list.length - 1]).filter((m) => m?.role === "assistant").map((m) => m!.content));
    expect([...drawn]).toEqual(["one", "one two", "one two three"]);
  });
});

describe("commitReplayedTurn", () => {
  const at = "2026-11-04T10:00:00Z";
  const prev: ChatMessage[] = [
    { id: "u0", role: "user", content: "earlier", timestamp: at },
    { id: "a0", role: "assistant", content: "done", timestamp: at },
    { id: "u1", role: "user", content: "now", timestamp: at },
    { id: "streaming-1", role: "assistant", content: "half", timestamp: at },
  ];

  it("swaps the running answer for the rebuilt one in one list", () => {
    const out = commitReplayedTurn(prev, "now", "c1", { content: "half and more", events: [], account: null, standaloneErrors: [] }, () => 7);
    expect(out.map((m) => m.id)).toEqual(["u0", "a0", "u1", "streaming-7"]);
    expect(out[3]!.content).toBe("half and more");
  });

  it("leaves only the prompt when the replay rebuilt nothing", () => {
    const out = commitReplayedTurn(prev, "now", "c1", { content: "", events: [], account: null, standaloneErrors: [] });
    expect(out.map((m) => m.id)).toEqual(["u0", "a0", "u1"]);
  });

  it("names the answer it will swap out, and nothing else", () => {
    expect([...replayReplacedIds(prev, "now", "c1")]).toEqual(["streaming-1"]);
  });
});
