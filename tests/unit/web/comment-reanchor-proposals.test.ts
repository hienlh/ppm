import { describe, expect, it } from "bun:test";
import { pickReanchorProposals } from "../../../src/web/components/design/comments/use-comment-pins";

describe("pickReanchorProposals", () => {
  it("accepts one proposal per comment id and marks it proposed", () => {
    const proposed = new Set<string>();
    const valid = new Set(["c1"]);
    const first = pickReanchorProposals([{ id: "c1", ppmId: 1, gen: "abc", reanchored: true }], valid, proposed);
    expect(first).toEqual([{ id: "c1", ppmId: 1, gen: "abc" }]);
    expect(proposed.has("c1")).toBe(true);
  });

  it("drops a second proposal for the same id even with a different ppmId or gen", () => {
    const proposed = new Set<string>();
    const valid = new Set(["c1"]);
    pickReanchorProposals([{ id: "c1", ppmId: 1, gen: "abc", reanchored: true }], valid, proposed);
    // A page that varies its answer must not be able to turn one comment into a flood.
    const second = pickReanchorProposals(
      [
        { id: "c1", ppmId: 2, gen: "def", reanchored: true },
        { id: "c1", ppmId: 3, gen: "ghi", reanchored: true },
      ],
      valid,
      proposed,
    );
    expect(second).toEqual([]);
  });

  it("drops ids the frame invents that were never asked to be pinned for this page", () => {
    const proposed = new Set<string>();
    const valid = new Set(["c1"]);
    const out = pickReanchorProposals([{ id: "unknown-id", ppmId: 1, gen: "abc", reanchored: true }], valid, proposed);
    expect(out).toEqual([]);
    expect(proposed.size).toBe(0);
  });

  it("ignores entries that are not a reanchor proposal", () => {
    const proposed = new Set<string>();
    const valid = new Set(["c1", "c2", "c3"]);
    const out = pickReanchorProposals(
      [
        { id: "c1", ppmId: null, gen: "abc", reanchored: true },
        { id: "c2", ppmId: 1, gen: null, reanchored: true },
        { id: "c3", ppmId: 1, gen: "abc", reanchored: false },
      ],
      valid,
      proposed,
    );
    expect(out).toEqual([]);
  });

  it("accepts several distinct comments in one message", () => {
    const proposed = new Set<string>();
    const valid = new Set(["c1", "c2"]);
    const out = pickReanchorProposals(
      [
        { id: "c1", ppmId: 1, gen: "abc", reanchored: true },
        { id: "c2", ppmId: 2, gen: "def", reanchored: true },
      ],
      valid,
      proposed,
    );
    expect(out).toEqual([
      { id: "c1", ppmId: 1, gen: "abc" },
      { id: "c2", ppmId: 2, gen: "def" },
    ]);
  });
});
