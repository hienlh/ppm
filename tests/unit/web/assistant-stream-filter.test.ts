/**
 * The Assistant stream's project filter and wake-turn folding: a turn is kept when the Assistant
 * reached that project's manager chat in it (by session id, or by project for a create), the
 * opening message comes with it, and a PPM-started turn answered `[no reply]` folds to one line.
 */
import { describe, expect, it } from "bun:test";
import {
  bareToolName, callTouchesManager, collapsedWakeTurns, groupTurns, hiddenByProjectFilter, type StreamRow,
} from "../../../src/web/lib/assistant-stream-filter";
import { managerDotState } from "../../../src/web/lib/assistant-manager-chip-state";

const at = (min: number) => new Date(Date.UTC(2026, 10, 10, 9, min)).toISOString();
const user = (id: string, min: number, content = "hi"): StreamRow => ({ id, role: "user", content, timestamp: at(min) });
const reply = (id: string, min: number, events: StreamRow["events"] = [], content = ""): StreamRow => ({ id, role: "assistant", content, timestamp: at(min), events });
const call = (tool: string, input: unknown) => ({ type: "tool_use", tool, input });

const nxsys = { projectName: "nxsys", sessionId: "mgr-nx" };

describe("assistant stream filter", () => {
  it("groups rows into turns at each user message", () => {
    expect(groupTurns([reply("a0", 0), user("u1", 1), reply("a1", 2), user("u2", 3)]).map((t) => t.map((r) => r.id)))
      .toEqual([["a0"], ["u1", "a1"], ["u2"]]);
  });

  it("names tools the same way for Claude and Codex", () => {
    expect(bareToolName("mcp__ppm-sessions__send_to_session")).toBe("send_to_session");
    expect(bareToolName("ppm_sessions.session_status")).toBe("session_status");
    expect(bareToolName("create_session")).toBe("create_session");
  });

  it("matches a call by session id, a status list, or the project for a create", () => {
    expect(callTouchesManager("mcp__ppm-sessions__send_to_session", { session_id: "mgr-nx", message: "x" }, nxsys)).toBe(true);
    expect(callTouchesManager("mcp__ppm-sessions__send_to_session", { session_id: "other" }, nxsys)).toBe(false);
    expect(callTouchesManager("mcp__ppm-sessions__session_status", { session_ids: ["a", "mgr-nx"] }, nxsys)).toBe(true);
    expect(callTouchesManager("mcp__ppm-sessions__create_session", { project: "nxsys", manager: true }, nxsys)).toBe(true);
    expect(callTouchesManager("mcp__ppm-sessions__create_session", { project: "ppm" }, nxsys)).toBe(false);
    expect(callTouchesManager("Bash", { session_id: "mgr-nx" }, nxsys)).toBe(false);
    expect(callTouchesManager("mcp__ppm-sessions__send_to_session", { session_id: "mgr-nx" }, { projectName: "nxsys", sessionId: null })).toBe(false);
  });

  it("keeps whole turns that reached the manager, with their opening message", () => {
    const rows = [
      user("u1", 0, "nxsys: release 2.14?"), reply("a1", 1, [call("mcp__ppm-sessions__send_to_session", { session_id: "mgr-nx" })]),
      reply("a1b", 2, [], "Asked the manager."),
      user("u2", 3, "and ppm?"), reply("a2", 4, [call("mcp__ppm-sessions__send_to_session", { session_id: "mgr-ppm" })]),
    ];
    expect([...hiddenByProjectFilter(rows, nxsys)].sort()).toEqual(["a2", "u2"]);
  });

  it("folds a PPM-started turn answered [no reply], and only that", () => {
    const rows = [
      user("u1", 0, "hello"), reply("a1", 1, [{ type: "text", content: "Hi." }]),
      user("w1", 5, "[PPM] News from manager chats — details are in the context."), reply("wa1", 6, [{ type: "text", content: "[no reply]" }]),
      user("w2", 8, "[PPM] News from manager chats — details are in the context."), reply("wa2", 9, [{ type: "text", content: "nxsys keeps failing." }]),
    ];
    const folded = collapsedWakeTurns(rows);
    expect(folded).toHaveLength(1);
    expect(folded[0]!.ids).toEqual(["w1", "wa1"]);
    expect(folded[0]!.since).toBe(Date.parse(at(0)));
    expect(folded[0]!.at).toBe(Date.parse(at(5)));
  });

  it("puts working before waiting on the chip dot", () => {
    expect(managerDotState({ phase: "streaming", waiting: 2 })).toBe("running");
    expect(managerDotState({ phase: "idle", waiting: 0 }, 1)).toBe("needs");
    expect(managerDotState({ phase: "idle", waiting: 3 }, 0)).toBe("idle");
  });
});
