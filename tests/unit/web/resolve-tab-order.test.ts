// Run in Docker (host Bun segfaults on `bun test`): docker run --rm -v "$PWD":/app -w /app oven/bun bun test tests/unit/web/resolve-tab-order.test.ts
import { describe, it, expect } from "bun:test";
import { resolveTabOrder } from "../../../src/web/lib/sidebar-tabs/resolve-tab-order.ts";
import type { SidebarActiveTab } from "../../../src/web/stores/settings-store.ts";

type Tab = { id: SidebarActiveTab };
const t = (id: SidebarActiveTab): Tab => ({ id });
const ids = (tabs: Tab[]) => tabs.map((x) => x.id);

const AVAILABLE: Tab[] = [t("history"), t("explorer"), t("git"), t("database"), t("settings")];

describe("resolveTabOrder", () => {
  it("empty/undefined saved → returns available unchanged", () => {
    expect(ids(resolveTabOrder(AVAILABLE, []))).toEqual(ids(AVAILABLE));
    expect(ids(resolveTabOrder(AVAILABLE, undefined))).toEqual(ids(AVAILABLE));
  });

  it("stable: saved fully covers available in custom order", () => {
    const saved: SidebarActiveTab[] = ["settings", "git", "history", "explorer", "database"];
    expect(ids(resolveTabOrder(AVAILABLE, saved))).toEqual(saved);
  });

  it("append-new: available id not in saved appended at end (available order)", () => {
    const saved: SidebarActiveTab[] = ["git", "history"];
    expect(ids(resolveTabOrder(AVAILABLE, saved))).toEqual([
      "git", "history", "explorer", "database", "settings",
    ]);
  });

  it("drop-missing: saved id absent from available is excluded", () => {
    const saved: SidebarActiveTab[] = ["jira", "git", "ext:foo", "history"];
    const out = ids(resolveTabOrder(AVAILABLE, saved));
    expect(out).not.toContain("jira");
    expect(out).not.toContain("ext:foo");
    expect(out).toEqual(["git", "history", "explorer", "database", "settings"]);
  });

  it("mixed: reorder + one new + one removed simultaneously", () => {
    const withExt: Tab[] = [...AVAILABLE, t("ext:tickets")];
    const saved: SidebarActiveTab[] = ["settings", "jira", "history"]; // jira removed, ext:tickets+git+explorer+database new
    expect(ids(resolveTabOrder(withExt, saved))).toEqual([
      "settings", "history", "explorer", "git", "database", "ext:tickets",
    ]);
  });

  it("ignores duplicate ids in saved", () => {
    const saved: SidebarActiveTab[] = ["git", "git", "history"];
    expect(ids(resolveTabOrder(AVAILABLE, saved))).toEqual([
      "git", "history", "explorer", "database", "settings",
    ]);
  });
});
