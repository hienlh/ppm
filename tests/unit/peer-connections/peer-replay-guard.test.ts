import { describe, expect, it } from "bun:test";
import { applyResync, classifyIncoming, MAX_SEQ_JUMP, planAfterNack } from "../../../src/services/peer-connections/peer-replay-guard.ts";

describe("receiver: classifyIncoming", () => {
  it("takes the next number", () => {
    expect(classifyIncoming(4, 5, "s5", null)).toEqual({ action: "accept" });
  });

  it("treats a resend of the stored envelope as success, not an error", () => {
    expect(classifyIncoming(5, 5, "s5", { sig: "s5" })).toEqual({ action: "duplicate" });
    expect(classifyIncoming(5, 2, "s2", { sig: "s2" })).toEqual({ action: "duplicate" });
  });

  it("never skips a gap: asks for the missing number", () => {
    expect(classifyIncoming(4, 6, "s6", null)).toEqual({ action: "nack", expectedSeq: 5 });
    expect(classifyIncoming(0, 9, "s9", null)).toEqual({ action: "nack", expectedSeq: 1 });
  });

  it("names the conflicting number and the envelope it holds there", () => {
    expect(classifyIncoming(7, 3, "other", { sig: "s3" })).toEqual({ action: "nack", expectedSeq: 8, conflict: { seq: 3, sig: "s3" } });
    expect(classifyIncoming(7, 3, "other", null)).toEqual({ action: "nack", expectedSeq: 8, conflict: { seq: 3 } });
  });
});

describe("sender: planAfterNack", () => {
  const gap = (expectedSeq: number, sendSeq: number, heldFrom: number) => planAfterNack({ expectedSeq, sendSeq, heldFrom, conflictIsOurs: null });

  it("resends what the receiver lacks when all of it is still held", () => {
    expect(gap(4, 8, 1)).toEqual({ action: "resend", from: 4, to: 8 });
    expect(gap(4, 8, 4)).toEqual({ action: "resend", from: 4, to: 8 });
  });

  it("declares a gap it can no longer fill and resends the rest", () => {
    expect(gap(2, 8, 5)).toEqual({ action: "resync", nextSeq: 5, to: 8, lost: 3 });
    expect(gap(2, 8, 9)).toEqual({ action: "resync", nextSeq: 9, to: 8, lost: 7 });
  });

  it("ignores a gap nack for numbers this side never assigned (a replay)", () => {
    expect(gap(9, 8, 1)).toEqual({ action: "ignore" });
    expect(gap(20, 8, 1)).toEqual({ action: "ignore" });
    expect(gap(0, 8, 1)).toEqual({ action: "ignore" });
  });

  it("renumbers only when its own envelope at the conflicting number provably differs", () => {
    expect(planAfterNack({ expectedSeq: 10, sendSeq: 3, heldFrom: 1, conflictIsOurs: true })).toEqual({ action: "jump", newSendSeq: 9, unknown: 6 });
    expect(planAfterNack({ expectedSeq: 4, sendSeq: 3, heldFrom: 1, conflictIsOurs: true })).toEqual({ action: "jump", newSendSeq: 3, unknown: 0 });
    // A replayed conflict nack about an envelope this side no longer has, or holds identically.
    expect(planAfterNack({ expectedSeq: 8, sendSeq: 7, heldFrom: 1, conflictIsOurs: false })).toEqual({ action: "ignore" });
  });

  it("refuses an implausible jump", () => {
    expect(planAfterNack({ expectedSeq: 5 + MAX_SEQ_JUMP + 1, sendSeq: 5, heldFrom: 1, conflictIsOurs: true })).toEqual({ action: "ignore" });
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
