/**
 * The `design` tab type is registered everywhere a tab type has to be: its id, its icon,
 * the pool that mounts it, the pop-out rules, and the URL round trip that restores it.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { installDom, uninstallDom } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);

const { deriveTabId, NON_POPPABLE_TAB_TYPES } = await import("../../../src/web/stores/panel-utils");
const { isPoppableTabType } = await import("../../../src/web/stores/window-panel-persistence");
const { TAB_TYPE_ICONS } = await import("../../../src/web/lib/tab-type-icons");
const { buildUrl, parseUrlState, tabIdFromUrl, buildMetadataFromUrl } = await import("../../../src/web/hooks/use-url-sync");
const { designTabMetadata } = await import("../../../src/web/lib/design/design-tab-metadata");

const SRC = resolve(import.meta.dir, "../../../src");

describe("design tab registration", () => {
  it("has one deterministic id per design", () => {
    expect(deriveTabId("design", { designSlug: "landing", sessionId: "s" })).toBe("design:landing");
  });

  it("cannot be popped out: the bridge only trusts frames whose parent is the main window", () => {
    expect(NON_POPPABLE_TAB_TYPES.has("design")).toBe(true);
    expect(isPoppableTabType("design")).toBe(false);
  });

  it("has an icon and a lazily loaded component", () => {
    expect(TAB_TYPE_ICONS.design).toBeDefined();
    const pool = readFileSync(resolve(SRC, "web/components/layout/tab-pool.tsx"), "utf8");
    expect(pool).toMatch(/design: lazy\(\(\) => import\("@\/components\/design\/design-tab"\)/);
  });

  it("round-trips through the URL and comes back with a pending, design-capable provider", () => {
    const url = buildUrl("my project", "design:landing");
    expect(url).toBe("/project/my%20project/design/landing");
    window.history.pushState(null, "", url);
    const parsed = parseUrlState();
    expect(parsed.projectName).toBe("my project");
    expect(parsed.tabType).toBe("design");
    expect(tabIdFromUrl(parsed.tabType!, parsed.tabIdentifier)).toBe("design:landing");
    expect(buildMetadataFromUrl("design", parsed.tabIdentifier, "my project")).toEqual({
      projectName: "my project", designSlug: "landing", providerPending: true,
    });
  });

  it("refuses a URL whose slug could not be a design folder", () => {
    for (const bad of ["../etc", "Landing", "a/b", "", null]) {
      expect(buildMetadataFromUrl("design", bad, "p")).toBeNull();
    }
  });
});

describe("design tab metadata", () => {
  it("writes no permission mode, so the chat loads the provider's configured default", () => {
    expect(designTabMetadata({ projectName: "p", designSlug: "d" })).toEqual({
      projectName: "p", designSlug: "d", providerPending: true,
    });
    expect(designTabMetadata({ projectName: "p", designSlug: "d", providerId: "codex", sessionId: "s", fresh: true }))
      .toEqual({ projectName: "p", designSlug: "d", providerId: "codex", sessionId: "s", designSessionChecked: true });
  });
});
