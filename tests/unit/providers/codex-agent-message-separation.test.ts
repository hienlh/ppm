/**
 * Two agent messages in one Codex turn used to stream as one run of text ("…in PPM.PPM has…")
 * while the transcript reader kept them as separate messages, so the live view and a reload
 * disagreed. The provider now carries per-turn text state into the mapper; both the stream
 * and the live transcript get a paragraph break between the messages.
 */
import { describe, expect, it } from "bun:test";
import { CodexAppServerProvider } from "../../../src/providers/codex-app-server/codex-provider.ts";
import { newCodexTurnText } from "../../../src/providers/codex-app-server/codex-event-mapper.ts";

function fixture() {
  const provider: any = new CodexAppServerProvider();
  const events: any[] = [];
  const live: any = {
    threadId: "root", cwd: "/tmp", permission: {},
    client: { request: () => Promise.resolve({}) },
    channel: { push: (event: any) => events.push(event) },
    history: [], transcript: [], currentAssistant: "", currentEvents: [], turnText: newCodexTurnText(),
    pendingTurns: [], subagentThreadIds: new Set(["child"]),
    turnInFlight: false,
  };
  provider.recordTurnUsage = () => {};
  const notify = (method: string, params: any = {}, threadId = "root") =>
    provider.handleNotification(live, { method, params: { threadId, ...params } });
  return { live, events, notify };
}

const streamed = (events: any[]) => events.filter((e) => e.type === "text" && !e.parentToolUseId).map((e) => e.content).join("");

describe("Codex agent messages in one turn", () => {
  it("are separated in the stream and in the live transcript, and a child's text stays out of it", () => {
    const { live, events, notify } = fixture();
    notify("turn/started", { turn: { id: "t1" } });
    notify("item/started", { item: { type: "agentMessage", id: "m1" } });
    notify("item/agentMessage/delta", { itemId: "m1", delta: "Registered in PPM." });
    notify("item/started", { item: { type: "mcpToolCall", id: "call", server: "ppm", tool: "projects_list" } });
    notify("item/agentMessage/delta", { itemId: "c1", delta: "child text" }, "child");
    notify("item/completed", { item: { type: "mcpToolCall", id: "call", server: "ppm", tool: "projects_list", result: { content: [] } } });
    notify("item/started", { item: { type: "agentMessage", id: "m2" } });
    notify("item/agentMessage/delta", { itemId: "m2", delta: "PPM has 2 projects." });
    notify("turn/completed", { turn: { id: "t" } });

    expect(streamed(events)).toBe("Registered in PPM.\n\nPPM has 2 projects.");
    expect(live.transcript.at(-1).content).toBe("Registered in PPM.\n\nPPM has 2 projects.");
    expect(events.find((e) => e.parentToolUseId === "subagent-child")).toMatchObject({ content: "child text" });
  });

  it("does not open the next turn with a break", () => {
    const { live, events, notify } = fixture();
    notify("turn/started", { turn: { id: "t1" } });
    notify("item/agentMessage/delta", { itemId: "m1", delta: "First turn." });
    notify("turn/completed", { turn: { id: "t" } });
    events.length = 0;
    notify("turn/started", { turn: { id: "t2" } });
    notify("item/started", { item: { type: "agentMessage", id: "m2" } });
    notify("item/agentMessage/delta", { itemId: "m2", delta: "Second turn." });
    notify("turn/completed", { turn: { id: "t" } });
    expect(streamed(events)).toBe("Second turn.");
    expect(live.transcript.map((m: any) => m.content)).toEqual(["First turn.", "Second turn."]);
  });
});
