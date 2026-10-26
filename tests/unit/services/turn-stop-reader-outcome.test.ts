/**
 * The latest turn's outcome from trace rows alone (newest first, as ROWS_SQL returns them):
 * the one case `lastTurnStop` deliberately hides — a user's Stop — must come out as its own
 * outcome, while an abort written after the turn already finished must not.
 */
import { describe, it, expect } from "bun:test";
import { lastTurnOutcome, type TurnStopRow } from "../../../src/services/session-trace/turn-stop-reader.ts";

let clock = 0;
/** Rows oldest first, as written; returned newest first, as read. */
function rows(...spec: Array<string | [string, Partial<TurnStopRow>]>): TurnStopRow[] {
  clock = 1_000;
  return spec.map((s) => {
    const [type, extra] = typeof s === "string" ? [s, {}] : s;
    return { type, ts: clock++, message: null, subtype: null, reason: null, ...extra };
  }).reverse();
}

const cancel: [string, Partial<TurnStopRow>] = ["turn_aborted", { reason: "ws_cancel" }];

describe("lastTurnOutcome", () => {
  it("null for a session with no rows", () => {
    expect(lastTurnOutcome([])).toBeNull();
  });

  it("done when the turn's last word is its done", () => {
    expect(lastTurnOutcome(rows("user_message", "text", "done"))).toEqual({ outcome: "done", at: 1002 });
  });

  it("cancelled for a Stop inside the turn, the provider's done coming after it", () => {
    expect(lastTurnOutcome(rows("user_message", "text", "tool_use", cancel, "done"))).toEqual({ outcome: "cancelled", at: 1003 });
  });

  it("cancelled for a Stop with nothing written after it", () => {
    expect(lastTurnOutcome(rows("user_message", "thinking", cancel))).toEqual({ outcome: "cancelled", at: 1002 });
  });

  it("done, not cancelled, when Stop was pressed after the turn had already finished", () => {
    expect(lastTurnOutcome(rows("user_message", "text", "done", cancel))).toEqual({ outcome: "done", at: 1002 });
  });

  it("not cancelled when the model kept producing after the abort", () => {
    expect(lastTurnOutcome(rows("user_message", cancel, "text", "done"))).toEqual({ outcome: "done", at: 1003 });
  });

  it("an abort for any other reason is not a cancel", () => {
    expect(lastTurnOutcome(rows("user_message", "text", ["turn_aborted", { reason: "idle_timeout" }], "done")))
      .toEqual({ outcome: "done", at: 1003 });
  });

  it("a Stop in an earlier turn does not leak into the latest one", () => {
    expect(lastTurnOutcome(rows("user_message", cancel, "done", "user_message", "text", "done")))
      .toEqual({ outcome: "done", at: 1005 });
  });

  it("max_turns with the provider's message and subtype", () => {
    const out = lastTurnOutcome(rows(
      "user_message", "tool_use",
      ["error", { message: "Reached maximum number of turns (500)" }],
      ["done", { subtype: "error_max_turns" }],
    ));
    expect(out).toEqual({ outcome: "max_turns", at: 1003, message: "Reached maximum number of turns (500)", subtype: "error_max_turns" });
  });

  it("error for a run that failed outright", () => {
    expect(lastTurnOutcome(rows("user_message", "text", ["run_failed", { message: "spawn ENOENT" }])))
      .toEqual({ outcome: "error", at: 1002, message: "spawn ENOENT" });
  });

  it("unfinished when the rows stop mid-turn", () => {
    expect(lastTurnOutcome(rows("user_message", "text", "tool_use"))).toEqual({ outcome: "unfinished", at: 1002 });
  });
});
