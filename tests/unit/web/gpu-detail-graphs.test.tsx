/**
 * The GPU page's three graphs — Mission Center's layout, ported.
 *
 * Two things are pinned here because both look right in review and wrong on a
 * real host. First, an integrated GPU has NO dedicated memory, so its memory
 * graph has to come from the shared figure or the page shows no memory at all —
 * which is what PPM did, against Mission Center reading "2.52 GiB / 62.5 GiB"
 * for the same UHD 770. Second, a driver that reports no video engine must get
 * no video graph rather than a flat zero line: "nothing is encoding" and "this
 * driver cannot tell you" are different claims, and the flat line states the
 * first while measuring neither.
 */
import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GpuDetail } from "../../../src/web/components/system/performance/gpu-detail.tsx";
import type { GpuInfo, GpuMetrics, MetricsHistoryPoint } from "../../../src/types/system-metrics";

const IGPU: GpuMetrics = {
  id: "0000:00:02.0",
  name: "Alder Lake-S GT1 [UHD Graphics 770]",
  utilPercent: 10,
  vramUsedMB: 0,
  vramTotalMB: 0,
  sharedUsedMB: 2580,
  sharedTotalMB: 64000,
  encodePercent: 2,
  clockMHz: 1433,
  clockMaxMHz: 1550,
};

const DISCRETE: GpuMetrics = {
  id: "0000:01:00.0",
  name: "Radeon RX 7900 XTX",
  utilPercent: 62,
  vramUsedMB: 4096,
  vramTotalMB: 24576,
  sharedUsedMB: 512,
  sharedTotalMB: 8192,
  encodePercent: 11,
  decodePercent: 4,
};

const SHARED_VIDEO: GpuInfo = { id: "0000:00:02.0", name: "UHD Graphics 770", encodeDecodeShared: true };

function history(gpu: GpuMetrics, points = 10): MetricsHistoryPoint[] {
  return Array.from({ length: points }, (_, t) => ({
    ts: 1_700_000_000_000 + t * 2000,
    groups: {},
    system: { gpus: [gpu] },
  } as unknown as MetricsHistoryPoint));
}

const render = (gpu: GpuMetrics, info?: GpuInfo) =>
  renderToStaticMarkup(<GpuDetail gpu={gpu} info={info} index={0} history={history(gpu)} />);

describe("GPU detail graphs", () => {
  it("draws three graphs for an integrated GPU: utilisation, video, shared memory", () => {
    const html = render(IGPU, SHARED_VIDEO);
    expect(html).toContain("Utilisation over");
    expect(html).toContain("Video encode/decode utilisation over");
    expect(html).toContain("Memory usage over");
    expect((html.match(/<canvas/g) ?? []).length).toBe(3);
  });

  it("an iGPU's memory graph is its share of system RAM, not a missing VRAM one", () => {
    const html = render(IGPU, SHARED_VIDEO);
    // The ceiling beside the caption is what makes the graph a reading.
    expect(html).toContain("62.5 GB");
    expect(html).not.toContain("Video memory usage");
  });

  it("a card with dedicated memory graphs that instead, and keeps both stats", () => {
    const html = render(DISCRETE);
    expect(html).toContain("Video memory usage over");
    expect(html).not.toContain(">Memory usage over");
    expect(html).toContain("24.0 GB");
    // Its shared (GTT) figure is still a separate stat, as Mission Center shows.
    expect(html).toContain("Shared memory");
  });

  it("one video engine gets one series; two get a two-entry legend", () => {
    expect(render(IGPU, SHARED_VIDEO)).not.toContain("Encode");
    const twoEngines = render(DISCRETE);
    expect(twoEngines).toContain("Encode");
    expect(twoEngines).toContain("Decode");
  });

  it("a driver that reports no video engine gets no video graph at all", () => {
    const { encodePercent: _e, ...noVideo } = IGPU;
    const html = render(noVideo as GpuMetrics, SHARED_VIDEO);
    expect(html).not.toContain("utilisation over");
    expect((html.match(/<canvas/g) ?? []).length).toBe(2);
  });

  it("a GPU with neither dedicated nor shared memory graphs neither", () => {
    const { sharedUsedMB: _u, sharedTotalMB: _t, ...bare } = IGPU;
    const html = render(bare as GpuMetrics, SHARED_VIDEO);
    expect(html).not.toContain("Memory usage over");
    expect((html.match(/<canvas/g) ?? []).length).toBe(2);
  });
});
