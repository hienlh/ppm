/**
 * The CPU graph's mode, and the per-thread grid's shape.
 *
 * The grid layout is Mission Center's, and the non-obvious part is that it is
 * NOT `ceil(sqrt(n))`: a 24-thread i9 comes out 6x4 there, where the naive rule
 * gives 5x5. Pinned against the real numbers because a layout that is merely
 * plausible looks identical in review.
 */
import { describe, it, expect } from "bun:test";
import {
  coreGridLayout,
  historySpanLabel,
  parseCpuGraphMode,
  parseCpuBottomGraph,
  CPU_GRAPH_MODES,
  CPU_BOTTOM_GRAPHS,
  MIN_CELL_PX,
} from "../../../src/web/lib/cpu-graph-mode";

const WIDE = 4000;

describe("parseCpuGraphMode", () => {
  it("keeps every mode it defines", () => {
    for (const m of CPU_GRAPH_MODES) expect(parseCpuGraphMode(m)).toBe(m);
  });

  it("falls back rather than trusting what came out of storage", () => {
    for (const junk of [undefined, null, "", "logical-processors", 3, {}, ["logical"]]) {
      expect(parseCpuGraphMode(junk)).toBe("overall");
    }
  });
});

describe("parseCpuBottomGraph", () => {
  it("keeps every mode it defines and defaults to temperature", () => {
    for (const m of CPU_BOTTOM_GRAPHS) expect(parseCpuBottomGraph(m)).toBe(m);
    expect(parseCpuBottomGraph("tempC")).toBe("temperature");
  });
});

describe("coreGridLayout", () => {
  it("puts 24 threads in 6 columns of 4, as Mission Center does", () => {
    expect(coreGridLayout(24, WIDE)).toEqual({ cols: 6, rows: 4 });
  });

  /** The naive rule would be 5 columns here, which is the wrong answer. */
  it("is not ceil(sqrt(n))", () => {
    expect(coreGridLayout(24, WIDE).cols).not.toBe(Math.ceil(Math.sqrt(24)));
  });

  it("covers every thread, for every count from 1 to 128", () => {
    for (let n = 1; n <= 128; n++) {
      const { cols, rows } = coreGridLayout(n, WIDE);
      expect(cols * rows).toBeGreaterThanOrEqual(n);
      expect(cols).toBeGreaterThan(0);
      expect(rows).toBeGreaterThan(0);
    }
  });

  it("draws nothing for a host that reported no per-core figures", () => {
    expect(coreGridLayout(0, WIDE)).toEqual({ cols: 0, rows: 0 });
  });

  it("drops columns to fit a narrow pane rather than shrinking past legibility", () => {
    const phone = coreGridLayout(24, 390);
    expect(phone.cols).toBe(Math.floor(390 / MIN_CELL_PX));
    expect(phone.cols * phone.rows).toBeGreaterThanOrEqual(24);
  });

  it("never goes below one column, however narrow the pane", () => {
    expect(coreGridLayout(24, 10).cols).toBe(1);
  });

  /** Width 0 is "not laid out yet", not "no room" — clamping there would draw a
   *  24-row single column for the frame before the measurement lands. */
  it("treats an unmeasured width as the full layout, not as no room", () => {
    expect(coreGridLayout(24, 0)).toEqual(coreGridLayout(24, WIDE));
  });

  it("never widens past what the host actually has", () => {
    expect(coreGridLayout(2, WIDE).cols).toBeLessThanOrEqual(2);
  });
});

describe("historySpanLabel", () => {
  const at = (...seconds: number[]) => seconds.map((s) => 1_700_000_000_000 + s * 1000);

  it("says nothing when there is not yet a span to describe", () => {
    expect(historySpanLabel([])).toBeUndefined();
    expect(historySpanLabel(at(0))).toBeUndefined();
  });

  it("counts seconds while the window is still filling", () => {
    expect(historySpanLabel(at(0, 20, 42))).toBe("over 42 seconds");
  });

  it("switches to minutes once there are enough of them", () => {
    expect(historySpanLabel(at(0, 120))).toBe("over 2 minutes");
    expect(historySpanLabel(at(0, 400))).toBe("over 7 minutes");
  });

  it("does not say '1 minutes'", () => {
    expect(historySpanLabel(at(0, 95))).toBe("over 2 minutes");
    expect(historySpanLabel(at(0, 100))).toBe("over 2 minutes");
  });

  /** PPM's window is the server's cadence times 200 points, and the two tiers
   *  differ — so a hardcoded "over 1 minute" would be wrong on at least one. */
  it("describes the full tier's window differently from the light tier's", () => {
    const full = historySpanLabel(at(0, 2 * 199));
    const light = historySpanLabel(at(0, 5 * 199));
    expect(full).not.toBe(light);
  });
});
