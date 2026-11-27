import { describe, expect, it } from "bun:test";
import { applyResync, classifyIncoming, planAfterNack } from "../../../src/services/peer-connections/peer-replay-guard.ts";

describe("receiver: classifyIncoming", () => {
  it("takes the next number", () => {
    expect(classifyIncoming(4, 5, null)).toEqual({ action: "accept" });
  });

  it("treats a resend of stored bytes as success, not an error", () => {
    expect(classifyIncoming(5, 5, true)).toEqual({ action: "duplicate" });
    expect(classifyIncoming(5, 2, true)).toEqual({ action: "duplicate" });
  });

  it("never skips a gap: asks for the missing number", () => {
    expect(classifyIncoming(4, 6, null)).toEqual({ action: "nack", expectedSeq: 5, reason: "gap" });
    expect(classifyIncoming(0, 9, null)).toEqual({ action: "nack", expectedSeq: 1, reason: "gap" });
  });

  it("asks a sender whose numbering went back to move forward", () => {
    expect(classifyIncoming(7, 3, false)).toEqual({ action: "nack", expectedSeq: 8, reason: "conflict" });
    expect(classifyIncoming(7, 3, null)).toEqual({ action: "nack", expectedSeq: 8, reason: "conflict" });
  });
});

describe("sender: planAfterNack", () => {
  it("resends what the receiver lacks when it is all still held", () => {
    expect(planAfterNack(4, 8, 1, 8)).toEqual({ action: "resend", from: 4, to: 8 });
  });

  it("declares a gap it can no longer fill and resends the rest", () => {
    expect(planAfterNack(2, 8, 5, 8)).toEqual({ action: "resync", nextSeq: 5, to: 8, lost: 3 });
    expect(planAfterNack(2, 8, null, null)).toEqual({ action: "resync", nextSeq: 9, to: 8, lost: 7 });
  });

  it("jumps ahead when the receiver has seen numbers this side has forgotten", () => {
    expect(planAfterNack(10, 3, 1, 3)).toEqual({ action: "jump", newSendSeq: 9, unknown: 6 });
    // Receiver holds 1..3 under different bytes than the message now in flight as 3.
    expect(planAfterNack(4, 3, 1, 3)).toEqual({ action: "jump", newSendSeq: 3, unknown: 0 });
  });

  it("ignores a nack with nothing to do", () => {
    expect(planAfterNack(4, 3, 1, null)).toEqual({ action: "ignore" });
    expect(planAfterNack(0, 3, 1, 3)).toEqual({ action: "ignore" });
  });
});

describe("receiver: applyResync", () => {
  it("moves forward past the gap and counts what was lost", () => {
    expect(applyResync(1, 5)).toEqual({ action: "advance", newRecvSeq: 4, lost: 3 });
  });

  it("never moves back, and ignores a resync to where it already is", () => {
    expect(applyResync(6, 5)).toEqual({ action: "ignore" });
    expect(applyResync(4, 5)).toEqual({ action: "ignore" });
  });
});
