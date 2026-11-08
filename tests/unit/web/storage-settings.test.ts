/**
 * Settings → Storage replaced the Query Audit Log category, and its session trace form checks
 * the same floors the route enforces before sending anything.
 */
import { describe, expect, it } from "bun:test";
import {
  SETTINGS_CATEGORIES,
  isSettingsCategoryId,
  settingsCategoriesInGroup,
} from "../../../src/web/components/settings/settings-categories";
import { SECTIONS } from "../../../src/web/components/settings/settings-section-content";
import { checkSessionTraceLimits, traceUsage } from "../../../src/web/lib/storage-settings-view";
import {
  SESSION_TRACE_MIN_RETENTION_DAYS,
  SESSION_TRACE_MIN_SIZE_MB,
} from "../../../src/shared/storage-settings";

describe("Storage settings category", () => {
  it("sits in the Advanced group and has a pane", () => {
    const storage = SETTINGS_CATEGORIES.find((c) => c.id === "storage");
    expect(storage?.group).toBe("advanced");
    expect(storage?.label).toBe("Storage");
    expect(settingsCategoriesInGroup("advanced").map((c) => c.id)).toContain("storage");
    expect(SECTIONS.storage).toBeDefined();
  });

  it("replaces the Query Audit Log category", () => {
    expect(SETTINGS_CATEGORIES.some((c) => c.label === "Query Audit Log")).toBe(false);
    expect(isSettingsCategoryId("query-audit")).toBe(false);
    expect(Object.keys(SECTIONS)).not.toContain("query-audit");
  });

  it("maps every category to a pane and nothing else", () => {
    expect(Object.keys(SECTIONS).sort()).toEqual(SETTINGS_CATEGORIES.map((c) => c.id).sort());
  });
});

describe("checkSessionTraceLimits", () => {
  it("accepts whole numbers at or above the floors", () => {
    expect(checkSessionTraceLimits(String(SESSION_TRACE_MIN_RETENTION_DAYS), String(SESSION_TRACE_MIN_SIZE_MB))).toEqual({
      ok: true,
      value: { retention_days: SESSION_TRACE_MIN_RETENTION_DAYS, max_size_mb: SESSION_TRACE_MIN_SIZE_MB },
    });
    expect(checkSessionTraceLimits(" 30 ", "500")).toEqual({ ok: true, value: { retention_days: 30, max_size_mb: 500 } });
  });

  it("refuses retention below the floor or not a whole number", () => {
    for (const days of ["0", "", "abc", "1.5", "-3", "1e3"]) {
      const result = checkSessionTraceLimits(days, "500");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("Keep for");
    }
  });

  it("refuses a size below the floor or not a whole number", () => {
    for (const size of [String(SESSION_TRACE_MIN_SIZE_MB - 1), "", "12.5", "x"]) {
      const result = checkSessionTraceLimits("30", size);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(`${SESSION_TRACE_MIN_SIZE_MB} MB`);
    }
  });
});

describe("traceUsage", () => {
  const MB = 1024 * 1024;

  it("reads as used of cap", () => {
    expect(traceUsage(412 * MB, 500)).toEqual({ label: "412 MB of 500 MB", fraction: 412 / 500, over: false });
  });

  it("clamps the bar past the cap and flags it", () => {
    const usage = traceUsage(600 * MB, 500);
    expect(usage.fraction).toBe(1);
    expect(usage.over).toBe(true);
  });

  it("is an empty bar for an empty or missing file", () => {
    expect(traceUsage(0, 500)).toEqual({ label: "0 B of 500 MB", fraction: 0, over: false });
  });
});
