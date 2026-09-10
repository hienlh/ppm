// Run in Docker (host Bun segfaults on `bun test`): docker run --rm -v "$PWD":/app -w /app oven/bun bun test tests/unit/web/tab-registry-available-tabs.test.ts
import { describe, it, expect } from "bun:test";
import { getAvailableTabs, BUILTIN_SIDEBAR_TABS } from "../../../src/web/lib/sidebar-tabs/tab-registry.ts";

const ids = (tabs: { id: string }[]) => tabs.map((t) => t.id);

describe("getAvailableTabs", () => {
  it("has no settings entry — settings opens its own window, not a sidebar panel", () => {
    expect(ids(BUILTIN_SIDEBAR_TABS)).not.toContain("settings");
    expect(ids(getAvailableTabs({ jiraEnabled: true }))).not.toContain("settings");
  });

  it("omits Jira until it is enabled", () => {
    expect(ids(getAvailableTabs({ jiraEnabled: false }))).not.toContain("jira");
  });

  it("places Jira after the built-ins", () => {
    const out = ids(getAvailableTabs({ jiraEnabled: true }));
    expect(out[out.length - 1]).toBe("jira");
    expect(out.slice(0, -1)).toEqual(ids(BUILTIN_SIDEBAR_TABS));
  });

  it("keeps extension views last, after an enabled Jira", () => {
    const out = ids(getAvailableTabs({
      jiraEnabled: true,
      contributions: { views: { sidebar: [{ id: "tickets", name: "Tickets" }] } } as never,
    }));
    expect(out[out.length - 1]).toBe("ext:tickets");
    expect(out[out.length - 2]).toBe("jira");
  });

  it("does not mutate the built-in list across calls", () => {
    const before = ids(BUILTIN_SIDEBAR_TABS);
    getAvailableTabs({ jiraEnabled: true });
    getAvailableTabs({ jiraEnabled: true });
    expect(ids(BUILTIN_SIDEBAR_TABS)).toEqual(before);
  });
});
