import { describe, expect, test } from "bun:test";
import { ChatAttemptLifecycle, type ChatAttemptEvent } from "../../../src/web/lib/chat-attempt-lifecycle";

function setup() {
  const events: ChatAttemptEvent[] = [];
  return { events, lifecycle: new ChatAttemptLifecycle((event) => events.push(event)) };
}

describe("onboarding chat lifecycle evidence", () => {
  test("completes only a dispatched connected idle attempt with content", () => {
    const { events, lifecycle } = setup();
    lifecycle.start("a", true, true);
    lifecycle.finish(true);
    lifecycle.finish(true);
    expect(events.map((event) => event.type)).toEqual(["started", "succeeded"]);
    expect(events[0]!.attemptId).toBe(events[1]!.attemptId);
  });
  test("cancel, errors and disconnect latch failure before any late done", () => {
    for (const reason of ["cancel", "error", "disconnect"]) {
      const { events, lifecycle } = setup();
      lifecycle.start(reason, true, true);
      lifecycle.fail();
      lifecycle.finish(true);
      expect(events.map((event) => event.type)).toEqual(["started", "failed"]);
    }
  });
  test("old history and disconnected sends cannot become successes", () => {
    const { events, lifecycle } = setup();
    lifecycle.finish(true);
    lifecycle.start("a", true, false);
    lifecycle.finish(true);
    expect(events).toEqual([]);
  });
  test("overlapping follow-up invalidates ambiguous completion", () => {
    const { events, lifecycle } = setup();
    lifecycle.start("a", true, true);
    lifecycle.start("a", false, true);
    lifecycle.finish(true);
    expect(events.map((event) => event.type)).toEqual(["started", "failed"]);
  });
  test("migration preserves local attempt and real session swap invalidates it", () => {
    const { events, lifecycle } = setup();
    lifecycle.start("temporary", true, true);
    lifecycle.migrate("canonical");
    lifecycle.select("canonical");
    lifecycle.finish(true);
    expect(events.map((event) => event.type)).toEqual(["started", "session", "succeeded"]);
    expect(events[2]!.sessionId).toBe("canonical");
    lifecycle.start("a", true, true);
    lifecycle.select("b");
    lifecycle.finish(true);
    expect(events.at(-1)!.type).toBe("failed");
  });
  test("empty completion fails and a subsequent attempt can succeed", () => {
    const { events, lifecycle } = setup();
    lifecycle.start("a", true, true);
    lifecycle.finish(false);
    lifecycle.start("a", true, true);
    lifecycle.finish(true);
    expect(events.map((event) => event.type)).toEqual(["started", "failed", "started", "succeeded"]);
    expect(events[0]!.attemptId).not.toBe(events[2]!.attemptId);
  });
});
