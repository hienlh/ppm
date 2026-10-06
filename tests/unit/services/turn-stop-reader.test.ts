/**
 * How the last turn ended, read back from the session trace — the one record that keeps a
 * Max Turns stop, since Claude's transcript ends on the last tool result and says nothing.
 * The first case is the row sequence a real stop left (bee48c83, 2026-10-06: ..., tool_use,
 * error, done error_max_turns); every case that must NOT show a stop bar is pinned beside it.
 */
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { closeTraceDb } from "../../../src/services/session-trace/session-trace-db.ts";
import { appendBatch, recordTraceAlias } from "../../../src/services/session-trace/session-trace-store.ts";
import { readLastTurnStop } from "../../../src/services/session-trace/turn-stop-reader.ts";

const MAX_TURNS = "Agent reached maximum turn limit.\nReached maximum number of turns (500)";

const tempDirs: string[] = [];
const originalHome = process.env.PPM_HOME;

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "ppm-turn-stop-"));
  tempDirs.push(home);
  process.env.PPM_HOME = home;
  closeTraceDb();
  _resetPpmDir();
});

afterAll(() => {
  closeTraceDb();
  process.env.PPM_HOME = originalHome;
  _resetPpmDir();
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite handles linger on windows */ }
  }
});

type Event = { type: string; [key: string]: unknown };
let clock = 1_000;

/** Write `events` as one trace, the way the recorder does: one row each, in order. Returns each row's ts. */
function trace(traceId: string, events: Event[]): number[] {
  const stamps: number[] = [];
  appendBatch(events.map((event) => {
    const ts = clock++;
    stamps.push(ts);
    return {
      traceId, turnId: "turn", ts, source: event.type === "user_message" ? "server" : "agent", origin: "ws",
      providerId: "claude", refId: null, type: event.type, payloadJson: JSON.stringify(event),
    };
  }));
  return stamps;
}

const user = (text = "do the thing"): Event => ({ type: "user_message", text });
const toolUse: Event = { type: "tool_use", tool: "Bash", input: { command: "ls" }, toolUseId: "t1" };
const toolResult: Event = { type: "tool_result", output: "x".repeat(100_000), toolUseId: "t1" };
const maxTurnsError: Event = { type: "error", message: MAX_TURNS };
const maxTurnsDone: Event = { type: "done", sessionId: "s", resultSubtype: "error_max_turns", numTurns: 501 };

describe("readLastTurnStop", () => {
  it("reports a Max Turns stop with its message, its subtype and when the turn ended", () => {
    const at = trace("s", [user(), { type: "thinking", content: "..." }, toolUse, toolResult, maxTurnsError, maxTurnsDone]);
    expect(readLastTurnStop("s")).toEqual({ message: MAX_TURNS, subtype: "error_max_turns", at: at[5]! });
  });

  it("reports nothing for a turn that finished normally", () => {
    trace("s", [user(), toolUse, toolResult, { type: "text", content: "All done." }, { type: "done", resultSubtype: "success" }]);
    expect(readLastTurnStop("s")).toBeNull();
  });

  it("drops the stop once a newer message has been sent", () => {
    trace("s", [user(), toolUse, maxTurnsError, maxTurnsDone, user("tiếp tục đi em")]);
    expect(readLastTurnStop("s")).toBeNull();
  });

  it("reports nothing while a turn is still producing", () => {
    trace("s", [user(), toolUse, maxTurnsError, maxTurnsDone, user(), toolUse]);
    expect(readLastTurnStop("s")).toBeNull();
  });

  it("reports nothing for a turn somebody stopped on purpose", () => {
    trace("a", [user(), toolUse, { type: "turn_aborted", reason: "ws_cancel" }, { type: "done", resultSubtype: "error_during_execution" }]);
    trace("b", [user(), toolUse, { type: "turn_aborted", reason: "ws_cancel" }, { type: "error", message: "Agent encountered an error during execution." }, { type: "done", resultSubtype: "error_during_execution" }]);
    expect(readLastTurnStop("a")).toBeNull();
    expect(readLastTurnStop("b")).toBeNull();
  });

  it("looks no further back than the turn's own first row: an earlier turn's cancel is not this one's", () => {
    trace("s", [
      user(), toolUse, { type: "turn_aborted", reason: "ws_cancel" }, { type: "done", resultSubtype: "error_during_execution" },
      user("again"), toolUse, maxTurnsError, maxTurnsDone,
    ]);
    expect(readLastTurnStop("s")?.subtype).toBe("error_max_turns");
  });

  it("keeps the stop through what happens after the turn: an idle release and a subagent still streaming", () => {
    trace("s", [
      user(), toolUse, maxTurnsError, maxTurnsDone,
      { type: "turn_aborted", reason: "idle_timeout" },
      { type: "tool_use", tool: "Read", input: {}, toolUseId: "c1", parentToolUseId: "agent-1" },
      { type: "text", content: "child", parentToolUseId: "agent-1" },
    ]);
    expect(readLastTurnStop("s")?.subtype).toBe("error_max_turns");
  });

  it("does not count an error the model moved past, or a subagent's own error", () => {
    trace("a", [user(), { type: "error", message: "transient" }, { type: "text", content: "Recovered." }, { type: "done", resultSubtype: "success" }]);
    trace("b", [user(), { type: "text", content: "Done." }, { type: "error", message: "child broke", parentToolUseId: "agent-1" }, { type: "done", resultSubtype: "success" }]);
    expect(readLastTurnStop("a")).toBeNull();
    expect(readLastTurnStop("b")).toBeNull();
  });

  it("reports a run that threw, and an error with no done after it", () => {
    const failed = trace("a", [user(), toolUse, { type: "run_failed", message: "CLI exited with code 1" }]);
    const bare = trace("b", [user(), { type: "error", message: "Provider \"x\" not found" }]);
    expect(readLastTurnStop("a")).toEqual({ message: "CLI exited with code 1", at: failed[2]! });
    expect(readLastTurnStop("b")).toEqual({ message: "Provider \"x\" not found", at: bare[1]! });
  });

  it("follows a session id a provider migrated to, and answers null for a session never traced", () => {
    trace("original", [user(), toolUse, maxTurnsError, maxTurnsDone]);
    recordTraceAlias("migrated", "original");
    expect(readLastTurnStop("migrated")?.subtype).toBe("error_max_turns");
    expect(readLastTurnStop("never-ran")).toBeNull();
  });
});
