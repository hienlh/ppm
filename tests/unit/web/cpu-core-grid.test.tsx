/**
 * The per-logical-processor grid, rendered.
 *
 * `coreGridLayout` is tested on its own; this pins that the component actually
 * emits one cell per thread and puts the column count into the style, because a
 * grid that computes 6 and renders `repeat(1, ...)` looks identical in review and
 * wrong on screen.
 *
 * Effects do not run under `renderToStaticMarkup`, so `useElementWidth` reports 0
 * — which is the "not laid out yet" case, i.e. the full Mission Center layout.
 */
import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CpuCoreGrid } from "../../../src/web/components/system/performance/cpu-core-grid.tsx";
import type { MetricsHistoryPoint } from "../../../src/types/system-metrics";

function history(points: number, threads: number): MetricsHistoryPoint[] {
  return Array.from({ length: points }, (_, t) => ({
    ts: 1_700_000_000_000 + t * 2000,
    groups: {},
    system: {
      cpu: { total: 10, cores: Array.from({ length: threads }, (_, i) => (i + t) % 100), model: "x" },
    },
  } as unknown as MetricsHistoryPoint));
}

describe("CpuCoreGrid", () => {
  it("draws one cell per logical processor", () => {
    const html = renderToStaticMarkup(
      <CpuCoreGrid cores={new Array(24).fill(5)} history={history(20, 24)} />,
    );
    expect(html.match(/<canvas/g)?.length).toBe(24);
    expect(html).toContain('data-core-count="24"');
  });

  it("lays 24 threads out in six columns, as Mission Center does", () => {
    const html = renderToStaticMarkup(
      <CpuCoreGrid cores={new Array(24).fill(5)} history={history(20, 24)} />,
    );
    expect(html).toContain('data-cols="6"');
    expect(html).toContain("repeat(6, minmax(0, 1fr))");
  });

  it("names each cell's thread and its reading, for a tooltip", () => {
    const html = renderToStaticMarkup(
      <CpuCoreGrid cores={[12.4, 0]} history={history(5, 2)} />,
    );
    expect(html).toContain('title="CPU 0: 12%"');
    expect(html).toContain('title="CPU 1: 0%"');
  });

  /** A host that reports no per-core figures gets no empty frame. */
  it("renders nothing at all when there are no cores", () => {
    expect(renderToStaticMarkup(<CpuCoreGrid cores={[]} history={history(5, 0)} />)).toBe("");
  });

  /** A window shorter than the grid still draws every cell — the canvas has its
   *  own "not enough points yet" baseline and does not need guarding here. */
  it("draws every cell before the history window has filled", () => {
    const html = renderToStaticMarkup(
      <CpuCoreGrid cores={new Array(8).fill(1)} history={history(1, 8)} />,
    );
    expect(html.match(/<canvas/g)?.length).toBe(8);
  });
});
