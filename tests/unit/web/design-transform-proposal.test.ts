import { describe, expect, it } from "bun:test";
import {
  PARENT_GESTURE_WINDOW_MS, decideTransformProposal, readUserActivation, type ProposalContext,
} from "../../../src/web/lib/design/design-transform-proposal";

const GEN = "0123456789abcdef";
const proposal = { ppmId: 60, tag: "div", file: "index.html", gen: GEN };
const ctx = (over: Partial<ProposalContext> = {}): ProposalContext => ({
  moveOn: true,
  streaming: false,
  target: { ppmId: 60, tag: "div", file: "index.html" },
  ready: { gen: GEN, file: "index.html" },
  activation: true,
  lastParentGestureAt: null,
  now: 1_000_000,
  ...over,
});

describe("decideTransformProposal", () => {
  it("writes a proposal for the selected element right after a real gesture", () => {
    expect(decideTransformProposal(proposal, ctx())).toEqual({ kind: "write" });
  });

  it("never writes without user activation, whatever else holds", () => {
    expect(decideTransformProposal(proposal, ctx({ activation: false }))).toEqual({ kind: "reject", reason: "no-gesture" });
    // Even a gesture the parent saw does not override a browser that says there was none.
    expect(decideTransformProposal(proposal, ctx({ activation: false, lastParentGestureAt: 1_000_000 }))).toMatchObject({ kind: "reject" });
  });

  it("never writes for another element than the parent's target", () => {
    for (const p of [{ ...proposal, ppmId: 61 }, { ...proposal, tag: "p" }, { ...proposal, file: "about.html" }]) {
      expect(decideTransformProposal(p, ctx())).toEqual({ kind: "reject", reason: "wrong-target" });
    }
    expect(decideTransformProposal(proposal, ctx({ target: null }))).toEqual({ kind: "reject", reason: "wrong-target" });
  });

  it("never writes with Move off or while the design chat streams", () => {
    expect(decideTransformProposal(proposal, ctx({ moveOn: false }))).toEqual({ kind: "reject", reason: "mode-off" });
    expect(decideTransformProposal(proposal, ctx({ streaming: true }))).toEqual({ kind: "reject", reason: "streaming" });
  });

  it("never writes a proposal from a document other than the current one", () => {
    expect(decideTransformProposal({ ...proposal, gen: "fedcba9876543210" }, ctx())).toEqual({ kind: "reject", reason: "stale-frame" });
    expect(decideTransformProposal(proposal, ctx({ ready: null }))).toEqual({ kind: "reject", reason: "stale-frame" });
  });

  it("without the activation API, needs a gesture the parent saw within 5 s, else asks", () => {
    const noApi = { activation: null };
    expect(decideTransformProposal(proposal, ctx({ ...noApi, lastParentGestureAt: 1_000_000 - 1000 }))).toEqual({ kind: "write" });
    expect(decideTransformProposal(proposal, ctx({ ...noApi, lastParentGestureAt: 1_000_000 - PARENT_GESTURE_WINDOW_MS - 1 })))
      .toEqual({ kind: "confirm" });
    expect(decideTransformProposal(proposal, ctx({ ...noApi, lastParentGestureAt: null }))).toEqual({ kind: "confirm" });
    // A timestamp from the future is not a gesture.
    expect(decideTransformProposal(proposal, ctx({ ...noApi, lastParentGestureAt: 1_000_000 + 10 }))).toEqual({ kind: "confirm" });
  });
});

describe("readUserActivation", () => {
  it("reads isActive, and says null where the API is missing", () => {
    expect(readUserActivation({ userActivation: { isActive: true } })).toBe(true);
    expect(readUserActivation({ userActivation: { isActive: false } })).toBe(false);
    expect(readUserActivation({})).toBeNull();
    expect(readUserActivation(null)).toBeNull();
    expect(readUserActivation({ userActivation: { isActive: "yes" } })).toBeNull();
  });
});
