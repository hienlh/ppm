/**
 * The collapse from per-timing modes to per-size menu rows. The load-bearing case is the third
 * test: a host on a lower-refresh timing than it also advertises must still have its row
 * ticked, which a "keep the highest refresh" rule silently breaks.
 *
 * `fitLocalMode` is RustDesk's exact-match-or-nothing rule, which is the part that looks like a
 * bug: a client whose screen is not one of the host's advertised sizes gets no item at all.
 */
import { describe, expect, test } from "bun:test";
import {
  fitLocalMode, resolutionChoices, resolutionLabel,
} from "../../../src/web/components/remote-desktop/remote-desktop-resolution-list.ts";
import type { HostMode } from "../../../src/web/components/remote-desktop/use-remote-desktop-readiness.ts";

function mode(p: Partial<HostMode> & { id: string; width: number; height: number }): HostMode {
  return { refresh: 60, current: false, preferred: false, ...p };
}

describe("resolutionChoices", () => {
  test("collapses many timings to one row per size, largest first", () => {
    const rows = resolutionChoices([
      mode({ id: "a", width: 1920, height: 1080, refresh: 60 }),
      mode({ id: "b", width: 1920, height: 1080, refresh: 120 }),
      mode({ id: "c", width: 3440, height: 1440, refresh: 100 }),
      mode({ id: "d", width: 1280, height: 720, refresh: 60 }),
    ]);
    expect(rows.map((r) => `${r.width}x${r.height}`)).toEqual(["3440x1440", "1920x1080", "1280x720"]);
    // Highest refresh breaks the tie when nothing else distinguishes the group.
    expect(rows[1]!.id).toBe("b");
  });

  test("the live mode survives its group even at a lower refresh", () => {
    const rows = resolutionChoices([
      mode({ id: "fast", width: 3440, height: 1440, refresh: 100 }),
      mode({ id: "live", width: 3440, height: 1440, refresh: 60, current: true }),
    ]);
    expect(rows).toHaveLength(1);
    // The whole point: dropping "live" here leaves the menu with nothing ticked.
    expect(rows[0]!.id).toBe("live");
    expect(rows[0]!.current).toBe(true);
  });

  test("the native mode survives its group when neither is live", () => {
    const rows = resolutionChoices([
      mode({ id: "fast", width: 1920, height: 1080, refresh: 144 }),
      mode({ id: "native", width: 1920, height: 1080, refresh: 60, preferred: true }),
    ]);
    expect(rows[0]!.id).toBe("native");
  });

  test("drops zero-sized modes rather than offering a row that cannot apply", () => {
    expect(resolutionChoices([mode({ id: "z", width: 0, height: 0 })])).toEqual([]);
  });

  test("labels carry the refresh only when the host reported one", () => {
    expect(resolutionLabel({ id: "a", width: 3440, height: 1440, refresh: 100, current: false, preferred: false }))
      .toBe("3440 × 1440 · 100 Hz");
    expect(resolutionLabel({ id: "a", width: 800, height: 600, refresh: 0, current: false, preferred: false }))
      .toBe("800 × 600");
  });
});

describe("fitLocalMode", () => {
  const host = [
    mode({ id: "native", width: 3440, height: 1440, refresh: 100, current: true, preferred: true }),
    mode({ id: "fhd60", width: 1920, height: 1080, refresh: 60 }),
    mode({ id: "fhd120", width: 1920, height: 1080, refresh: 120 }),
    mode({ id: "hd", width: 1280, height: 720, refresh: 60 }),
  ];

  test("offers the mode that matches the client's screen exactly", () => {
    const fit = fitLocalMode(host, { width: 1920, height: 1080 }, "native");
    // Same timing the 1920x1080 menu row offers, so the two rows cannot disagree.
    expect(fit?.id).toBe("fhd120");
  });

  test("offers nothing when no host mode matches, rather than the nearest one", () => {
    // 1366x768 is between two advertised sizes; RustDesk hides the item instead of scaling.
    expect(fitLocalMode(host, { width: 1366, height: 768 }, "native")).toBeNull();
  });

  test("offers nothing once the host is already that size", () => {
    expect(fitLocalMode(host, { width: 3440, height: 1440 }, "native")).toBeNull();
  });

  test("is silent about a different refresh of the size the client already has", () => {
    // The host moved to 1920x1080@60 this session, so `current` still points at the old mode.
    // Compared by id this would offer @120 — a switch with nothing visible to show for it.
    expect(fitLocalMode(host, { width: 1920, height: 1080 }, "fhd60")).toBeNull();
  });

  test("falls back to the mode the host reports as current when the session has not switched", () => {
    expect(fitLocalMode(host, { width: 3440, height: 1440 }, null)).toBeNull();
    expect(fitLocalMode(host, { width: 1280, height: 720 }, null)?.id).toBe("hd");
  });

  test("offers nothing without a usable local screen", () => {
    expect(fitLocalMode(host, null, "native")).toBeNull();
    expect(fitLocalMode(host, { width: 0, height: 0 }, "native")).toBeNull();
  });
});
