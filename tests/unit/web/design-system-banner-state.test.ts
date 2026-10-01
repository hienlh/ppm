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
  it("offers nothing while the app has no design system yet: the design's own first turn sets it up", () => {
    expect(designSystemBannerKind({ ...base, system: system() })).toBeNull();
  });

  it("offers a refresh only for a known stale system", () => {
    expect(designSystemBannerKind({ ...base, system: ready })).toBeNull();
    expect(designSystemBannerKind({ ...base, system: ready, stale: { stale: true, changedFiles: 23, unknown: false } })).toBe("refresh");
    expect(designSystemBannerKind({ ...base, system: ready, stale: { stale: true, unknown: true } })).toBeNull();
  });

  it("stays hidden while a turn runs, before the system loads, and once dismissed", () => {
    const stale = { stale: true, changedFiles: 23, unknown: false };
    expect(designSystemBannerKind({ ...base, system: ready, stale, isStreaming: true })).toBeNull();
    expect(designSystemBannerKind({ ...base, system: null, stale })).toBeNull();
    expect(designSystemBannerKind({ ...base, system: ready, stale, dismissed: ["refresh"] })).toBeNull();
  });

  it("keeps one key per project and app, and reads stored dismissals tolerantly, dropping an unknown kind", () => {
    expect(designSystemBannerKey("nxsys", "payroll-fe")).not.toBe(designSystemBannerKey("nxsys", "umbrella-fe"));
    expect(parseDismissed(JSON.stringify(["refresh", "setup", "bogus", 3]))).toEqual(["refresh"]);
    expect(parseDismissed("{not json")).toEqual([]);
    expect(parseDismissed(null)).toEqual([]);
  });
});
