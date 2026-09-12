/**
 * The Overview GPU card against the `undefined` = cannot measure contract.
 *
 * `GpuMetrics` says a `vramTotalMB` of 0 means the device has no dedicated
 * memory to report — an integrated GPU — and that the UI must then show no
 * memory figure "rather than '0 B / 0 B'". The card printed it anyway, so an
 * i9-12900K's UHD 770 read as a graphics card with zero VRAM installed, which
 * is a different claim from "this device does not have any".
 *
 * The Performance page's GPU detail already renders that case as an em dash, so
 * the two surfaces disagreed about the same number on the same host.
 */
import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GpuCard } from "../../../src/web/components/system/overview-cards/gpu-card.tsx";

const BASE = { name: "Alder Lake-S GT1 [UHD Graphics 770]", utilPercent: 19, series: [] as number[] };

describe("Overview GPU card VRAM line", () => {
  it("omits the memory line when the device reports no dedicated memory", () => {
    const html = renderToStaticMarkup(<GpuCard {...BASE} vramUsedMB={0} vramTotalMB={0} />);
    expect(html).not.toContain("VRAM");
    expect(html).not.toContain("0 MB");
  });

  it("still names the device and its utilisation without the memory line", () => {
    const html = renderToStaticMarkup(<GpuCard {...BASE} vramUsedMB={0} vramTotalMB={0} />);
    expect(html).toContain("UHD Graphics 770");
    expect(html).toContain("19%");
  });

  it("shows the memory line for a card that has some", () => {
    const html = renderToStaticMarkup(
      <GpuCard {...BASE} name="GeForce RTX 4070" vramUsedMB={2048} vramTotalMB={12288} />,
    );
    expect(html).toContain("VRAM 2.0 GB / 12.0 GB");
  });

  /** Used memory can legitimately be 0 on a card that has memory and is idle —
   *  that is a real reading, not a missing one, so the line stays. */
  it("keeps the line when the total is real and only the used figure is zero", () => {
    const html = renderToStaticMarkup(
      <GpuCard {...BASE} name="GeForce RTX 4070" vramUsedMB={0} vramTotalMB={12288} />,
    );
    expect(html).toContain("VRAM 0 MB / 12.0 GB");
  });
});
