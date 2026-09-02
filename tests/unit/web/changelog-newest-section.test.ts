/**
 * The upgrade offer is derived from the newest version named in the release
 * notes, so this reduction is load-bearing: reading the oldest section instead
 * silently withholds the upgrade button for a release that is already out.
 */
import { describe, it, expect } from "bun:test";
import { newestSectionVersion, parseChangelog } from "../../../src/web/lib/changelog.ts";

const section = (version: string) => ({ version, date: "", body: "" });

describe("newestSectionVersion", () => {
  it("returns null for no sections", () => {
    expect(newestSectionVersion([])).toBeNull();
  });

  it("returns the only version present", () => {
    expect(newestSectionVersion([section("0.17.54")])).toBe("0.17.54");
  });

  it("takes the newest from a newest-first list", () => {
    expect(newestSectionVersion(["0.17.54", "0.17.53", "0.17.45"].map(section))).toBe("0.17.54");
  });

  it("takes the newest regardless of order", () => {
    expect(newestSectionVersion(["0.17.45", "0.17.54", "0.17.53"].map(section))).toBe("0.17.54");
  });

  it("compares numerically, not lexically", () => {
    expect(newestSectionVersion(["0.9.9", "0.17.0"].map(section))).toBe("0.17.0");
    expect(newestSectionVersion(["0.17.9", "0.17.54"].map(section))).toBe("0.17.54");
  });

  it("reads the newest version out of real changelog markdown", () => {
    const md = [
      "# Changelog", "",
      "## [0.17.54] - 2026-09-02", "### Added", "- a", "",
      "## [0.17.53] - 2026-09-02", "### Fixed", "- b", "",
    ].join("\n");
    expect(newestSectionVersion(parseChangelog(md))).toBe("0.17.54");
  });
});
