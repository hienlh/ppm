/**
 * Which chats had a turn end since a moment, read from the trace: the newest end per chat, the
 * chat named by the id it goes by now, and an error-ended turn marked as stopped.
 */
import { afterAll, beforeEach, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { closeTraceDb } from "../../../src/services/session-trace/session-trace-db.ts";
import { appendBatch } from "../../../src/services/session-trace/session-trace-store.ts";
import { turnEndsSince } from "../../../src/services/session-trace/turn-ends-query.ts";
import { setSessionMigratedTo } from "../../../src/services/db.service.ts";

const tempDirs: string[] = [];
const originalHome = process.env.PPM_HOME;

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "ppm-turn-ends-"));
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

function trace(traceId: string, at: number, events: Event[], providerId = "claude"): void {
  appendBatch(events.map((event, i) => ({
    traceId, turnId: "turn", ts: at + i, source: event.type === "user_message" ? "server" : "agent", origin: "ws",
    providerId, refId: null, type: event.type, payloadJson: JSON.stringify(event),
  })));
}

it("lists each chat once with its newest end, newest first, and ignores ends before the moment", () => {
  trace("old", 100, [{ type: "user_message" }, { type: "text" }, { type: "done" }]);
  trace("a", 1_000, [{ type: "user_message" }, { type: "text" }, { type: "done" }]);
  trace("a", 3_000, [{ type: "user_message" }, { type: "text" }, { type: "done" }]);
  trace("b", 2_000, [{ type: "user_message" }, { type: "tool_use" }, { type: "error", message: "Reached maximum number of turns" }, { type: "done", resultSubtype: "error_max_turns" }], "codex");

  const ends = turnEndsSince(500);
  expect(ends.map((e) => [e.sessionId, e.endedAt, e.providerId])).toEqual([["a", 3_002, "claude"], ["b", 2_003, "codex"]]);
  expect(ends[0]!.stop).toBeUndefined();
  expect(ends[1]!.stop).toMatchObject({ message: "Reached maximum number of turns", subtype: "error_max_turns" });
});

it("names a renamed chat by its current id and leaves a subagent's rows out", () => {
  setSessionMigratedTo("first-id", "codex-thread");
  trace("first-id", 5_000, [{ type: "user_message" }, { type: "text" }, { type: "done" }]);
  trace("sub-only", 6_000, [{ type: "done", parentToolUseId: "toolu_1" }]);
  const ends = turnEndsSince(4_000);
  expect(ends).toEqual([{ sessionId: "codex-thread", traceId: "first-id", providerId: "claude", endedAt: 5_002 }]);
});
