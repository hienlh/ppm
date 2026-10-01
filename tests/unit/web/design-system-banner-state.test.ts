import { describe, expect, it } from "bun:test";
import {
  designSystemBannerKey, designSystemBannerKind, parseDismissed,
} from "../../../src/web/lib/design/design-system-banner-state";
import type { DesignSystemSummary } from "../../../src/shared/design-types";

const system = (extra: Partial<DesignSystemSummary> = {}): DesignSystemSummary => ({
  id: "payroll-fe", label: "Payroll", root: "payroll-fe", platform: "web", declared: true,
  hasDesignMd: false, hasTokensCss: false, ...extra,
});
const ready = system({ hasDesignMd: true, builtFrom: { commit: "abc", at: "2026-10-01T00:00:00.000Z" } });
const base = { stale: null, dismissed: [], isStreaming: false };

describe("design system banner", () => {
  it("offers setup while the app has no design system", () => {
    expect(designSystemBannerKind({ ...base, system: system() })).toBe("setup");
  });

  it("offers a refresh only for a known stale system", () => {
    expect(designSystemBannerKind({ ...base, system: ready })).toBeNull();
    expect(designSystemBannerKind({ ...base, system: ready, stale: { stale: true, changedFiles: 23, unknown: false } })).toBe("refresh");
    expect(designSystemBannerKind({ ...base, system: ready, stale: { stale: true, unknown: true } })).toBeNull();
  });

  it("stays hidden while a turn runs, before the system loads, and once dismissed", () => {
    expect(designSystemBannerKind({ ...base, system: system(), isStreaming: true })).toBeNull();
    expect(designSystemBannerKind({ ...base, system: null })).toBeNull();
    expect(designSystemBannerKind({ ...base, system: system(), dismissed: ["setup"] })).toBeNull();
  });

  it("a dismissed setup does not hide a later refresh", () => {
    const stale = { stale: true, changedFiles: 30, unknown: false };
    expect(designSystemBannerKind({ ...base, system: ready, stale, dismissed: ["setup"] })).toBe("refresh");
  });

  it("keeps one key per project and app, and reads stored dismissals tolerantly", () => {
    expect(designSystemBannerKey("nxsys", "payroll-fe")).not.toBe(designSystemBannerKey("nxsys", "umbrella-fe"));
    expect(parseDismissed(JSON.stringify(["setup", "bogus", 3]))).toEqual(["setup"]);
    expect(parseDismissed("{not json")).toEqual([]);
    expect(parseDismissed(null)).toEqual([]);
  });
});
