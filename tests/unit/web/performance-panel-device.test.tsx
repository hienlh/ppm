/**
 * The Performance page's selected device now comes from a prop, so an Overview
 * card can set it on the way in — and that removed a piece of state.
 *
 * `PerformancePanel` used to hold `wanted` (the key) *and* `drilled` (whether the
 * phone shows the list or one device). Once the parent owns the key the second is
 * redundant: tapping a row sets the key, the back button clears it, and a jump
 * from an Overview card sets it too — which is exactly what makes a phone land on
 * the device rather than on the list it would otherwise have to be tapped
 * through. This pins that equivalence, because the phone branch is the one with
 * no way to reach it by hand: the only caller of `useOpenSystemMonitor` is
 * `ResourceStatusBar`, which is `hidden md:flex`.
 */
import { describe, it, expect, mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { MetricsHistoryPoint, SystemMetrics } from "../../../src/types/system-metrics";

let mobile = false;
mock.module("@/hooks/use-is-mobile", () => ({ useIsMobile: () => mobile }));
mock.module("@/hooks/use-hardware-inventory", () => ({ useHardwareInventory: () => null }));

const { PerformancePanel } = await import(
  "../../../src/web/components/system/performance/performance-panel.tsx"
);

const system = {
  cpu: { total: 5, cores: [5], model: "i9-12900K", kernelPercent: 1, coreKernel: [1] },
  mem: { totalMB: 64000, usedMB: 21000, availableMB: 43000, percent: 33 },
  disk: { available: true, inBps: 0, outBps: 0 },
  net: { available: true, inBps: 0, outBps: 0 },
  disks: [
    { id: "sdb", available: true, busyPercent: 0, responseMs: 0, readBps: 0, writeBps: 0, readTotal: 0, writeTotal: 0 },
    { id: "sda", available: true, busyPercent: 76, responseMs: 1, readBps: 0, writeBps: 0, readTotal: 0, writeTotal: 0 },
  ],
  nics: [],
  gpus: [],
  processCount: 0,
} as unknown as SystemMetrics;

const history: MetricsHistoryPoint[] = [];
const render = (device: string | null) =>
  renderToStaticMarkup(
    <PerformancePanel system={system} history={history} device={device} onDeviceChange={() => {}} />,
  );

describe("desktop", () => {
  it("nothing chosen falls back to the first entry, as it always did", () => {
    mobile = false;
    const html = render(null);
    expect(html).toContain("sysmon-device-list");
    // CPU is entry 0, so its row is the current one with no request made.
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("i9-12900K");
  });

  it("a requested device is the one selected", () => {
    mobile = false;
    const html = render("disk:sda");
    // The detail pane renders the requested drive, not the first one.
    expect(html).toContain("Disk 1");
  });

  it("a key matching no device does not blank the page", () => {
    mobile = false;
    // A drive unplugged between the click and the render.
    const html = render("disk:gone");
    expect(html).toContain("sysmon-device-list");
    expect(html).toContain('aria-current="true"');
  });
});

describe("phone", () => {
  it("no device chosen shows the device list, never an arbitrary detail", () => {
    mobile = true;
    const html = render(null);
    expect(html).toContain("sysmon-device-list");
    expect(html).not.toContain("Devices</button>");
  });

  it("a device chosen lands ON it — what `drilled` used to do", () => {
    mobile = true;
    const html = render("disk:sda");
    expect(html).not.toContain("sysmon-device-list");
    // The back affordance is what says we are one level in.
    expect(html).toContain("Devices");
  });

  it("a stale key still shows the list rather than a blank drill-down", () => {
    mobile = true;
    expect(render("disk:gone")).toContain("sysmon-device-list");
  });
});
