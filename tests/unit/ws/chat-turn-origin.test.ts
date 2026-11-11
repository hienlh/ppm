/**
 * Whose turn a running turn is. A scheduled script posting into a PPM Assistant session opens an
 * unattended turn, but never turns the user's running turn into one (which would refuse their
 * approvals and session creates mid-task); a queued message owns only the turn it opens.
 */
import { describe, expect, it } from "bun:test";
import {
  claimTurnOrigin, noteQueuedTurnOrigin, turnOriginAfterTurn, turnRunning, type ArrivingMessage, type TurnOriginEntry,
} from "../../../src/server/ws/chat-turn-origin.ts";

const script: ArrivingMessage = { origin: "ws", scripted: true, assistant: true, priority: "next" };
const user: ArrivingMessage = { origin: "ws", scripted: false, assistant: false, priority: "next" };
const running = (turnOrigin: TurnOriginEntry["turnOrigin"]): TurnOriginEntry => ({ turnOrigin, phase: "thinking", isStreamingActive: true });

/** What `deliverMessage` does around one hand-off. */
function arrive(entry: TurnOriginEntry, m: ArrivingMessage, delivered: "started" | "inserted" | "queued") {
  const wasRunning = turnRunning(entry);
  claimTurnOrigin(entry, m);
  noteQueuedTurnOrigin(entry, m, delivered, wasRunning);
}

describe("the owner of a running turn", () => {
  it("is not taken from the user by a scheduled script reaching their running turn", () => {
    for (const delivered of ["inserted", "queued"] as const) {
      const entry = running("ws");
      arrive(entry, script, delivered);
      expect(entry.turnOrigin).toBe("ws");
    }
  });

  it("is PPM's, unattended, for a turn a scheduled script opens in an Assistant session", () => {
    const entry: TurnOriginEntry = { turnOrigin: "ws", phase: "idle", isStreamingActive: true };
    arrive(entry, script, "started");
    expect(entry.turnOrigin).toBe("watch");
  });

  it("goes to a queued script only for the turn it opens, after the user's turn ends", () => {
    const entry = running("ws");
    arrive(entry, script, "queued");
    expect(entry.turnOrigin).toBe("ws");
    turnOriginAfterTurn(entry);
    expect(entry.turnOrigin).toBe("watch");
    expect(entry.nextTurnOrigin).toBeUndefined();
  });

  it("becomes the user's when they type into a watch turn, but not for a message they queue for later", () => {
    const joined = running("watch");
    arrive(joined, user, "inserted");
    expect(joined.turnOrigin).toBe("ws");
    const queued = running("watch");
    arrive(queued, { ...user, priority: "later" }, "queued");
    expect(queued.turnOrigin).toBe("watch");
    turnOriginAfterTurn(queued);
    expect(queued.turnOrigin).toBe("ws");
  });

  it("forgets a queued owner when a new turn is opened instead", () => {
    const entry = running("ws");
    arrive(entry, script, "queued");
    entry.phase = "idle";
    arrive(entry, user, "started");
    turnOriginAfterTurn(entry);
    expect(entry.turnOrigin).toBe("ws");
  });
});
