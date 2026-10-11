import { describe, expect, it } from "bun:test";
import {
  buildUiStateSnapshot, MAX_SNAPSHOT_CHARS, MAX_SNAPSHOT_TITLE_CHARS, tabDetails, type UiStateInput,
} from "../../../src/web/lib/assistant-ui/ui-state-snapshot";
import { buildUiSummary } from "../../../src/web/lib/assistant-ui/ui-summary";
import type { Panel } from "../../../src/web/stores/panel-utils";
import type { Tab } from "../../../src/web/stores/tab-store";
import type { WindowRuntimeState } from "../../../src/web/components/floating-window/window-store-types";

const tab = (id: string, type: Tab["type"], title: string, projectId: string | null, metadata?: Record<string, unknown>): Tab =>
  ({ id, type, title, projectId, closable: true, ...(metadata ? { metadata } : {}) });
const panel = (id: string, tabs: Tab[], activeTabId: string | null = tabs[0]?.id ?? null): Panel =>
  ({ id, tabs, activeTabId, tabHistory: [] });
const win = (id: string, kind: WindowRuntimeState["kind"], rank: number, state: WindowRuntimeState["state"], payload?: Record<string, unknown>): WindowRuntimeState =>
  ({ id, kind, rank, opened: rank, state, rect: { x: 0, y: 0, w: 400, h: 300 }, ...(payload ? { payload } : {}) });

function input(over: Partial<UiStateInput> = {}): UiStateInput {
  return {
    currentProject: "api",
    layout: "desktop",
    panels: {
      left: panel("left", [
        tab("chat-1", "chat", "Fix login", "api", { sessionId: "s-1", providerId: "claude", pendingMessage: "half typed", pickedAccountId: "acc" }),
        tab("ed-1", "editor", "auth.ts", "api", { filePath: "src/auth.ts", unsavedContent: "SECRET=1", lineNumber: 12 }),
        tab("other-proj", "editor", "web.ts", "web", { filePath: "web.ts" }),
      ], "ed-1"),
      right: panel("right", [tab("db-1", "database", "users", "api", { connectionId: 3, tableName: "users", currentSql: "DELETE FROM users" })]),
      __dock__: panel("__dock__", [tab("term-1", "terminal", "Terminal 1", "api", { terminalIndex: 1 }), tab("term-web", "terminal", "Terminal 2", "web")]),
      "__win__:w1": panel("__win__:w1", [tab("design-1", "design", "Landing", "web", { designSlug: "landing", sessionId: "s-9" })]),
    },
    grid: [["left", "right"]],
    focusedPanelId: "right",
    dock: { visible: true, height: 30 },
    dockExpanded: false,
    windows: [win("w2", "settings", 1, "minimized"), win("w1", "tab-host", 0, "normal", { title: "stale title" })],
    ...over,
  };
}

describe("ui state snapshot", () => {
  it("lists every panel's tabs for the current project, the active tab and the focused panel", () => {
    const snap = buildUiStateSnapshot(input());
    expect(snap.currentProject).toBe("api");
    expect(snap.focusedPanelId).toBe("right");
    const [left, right, dock, hosted] = snap.panels;
    expect(left).toMatchObject({ id: "left", area: "grid", position: { row: 0, col: 0 }, focused: false, activeTabId: "ed-1" });
    expect(left!.tabs.map((t) => t.id)).toEqual(["chat-1", "ed-1"]);
    expect(left!.tabs[1]).toMatchObject({ type: "editor", title: "auth.ts", project: "api", active: true });
    expect(right).toMatchObject({ area: "grid", position: { row: 0, col: 1 }, focused: true });
    expect(dock!.area).toBe("dock");
    expect(dock!.tabs.map((t) => t.id)).toEqual(["term-1"]);
    expect(snap.dock).toEqual({ visible: true, expanded: false });
    // A floating window keeps its tabs whichever project is current.
    expect(hosted).toMatchObject({ id: "__win__:w1", area: "window" });
    expect(hosted!.tabs[0]).toMatchObject({ id: "design-1", project: "web" });
  });

  it("passes on only the allow-listed metadata of each tab type", () => {
    const snap = buildUiStateSnapshot(input());
    const tabs = snap.panels.flatMap((p) => p.tabs);
    const byId = (id: string) => tabs.find((t) => t.id === id)!;
    expect(byId("chat-1").details).toEqual({ sessionId: "s-1", providerId: "claude" });
    expect(byId("ed-1").details).toEqual({ filePath: "src/auth.ts", lineNumber: 12 });
    expect(byId("db-1").details).toEqual({ connectionId: 3, tableName: "users" });
    expect(byId("design-1").details).toEqual({ designSlug: "landing", sessionId: "s-9" });
    expect(JSON.stringify(snap)).not.toContain("SECRET");
    expect(JSON.stringify(snap)).not.toContain("DELETE FROM");
    expect(JSON.stringify(snap)).not.toContain("half typed");
    // Objects and unknown types carry nothing.
    expect(tabDetails({ type: "editor", metadata: { filePath: { nested: true } } })).toBeUndefined();
    expect(tabDetails({ type: "problems", metadata: { filePath: "x" } })).toBeUndefined();
  });

  it("lists floating windows back to front with kind, title and state", () => {
    const snap = buildUiStateSnapshot(input());
    expect(snap.windows).toEqual([
      // A tab-host window is named after the tab it hosts, not the title captured at pop-out.
      { id: "w1", kind: "tab-host", title: "Landing", state: "normal", front: true, panelId: "__win__:w1" },
      { id: "w2", kind: "settings", title: "settings", state: "minimized", front: false },
    ]);
  });

  it("cuts long titles and stays under its size cap, saying what it left out", () => {
    const many = Array.from({ length: 800 }, (_, i) => tab(`t${i}`, "editor", `${"long name ".repeat(30)}${i}`, "api", { filePath: `src/${"d/".repeat(60)}f${i}.ts` }));
    const snap = buildUiStateSnapshot(input({ panels: { left: panel("left", many) }, grid: [["left"]], focusedPanelId: "left", windows: [] }));
    expect(JSON.stringify(snap).length).toBeLessThanOrEqual(MAX_SNAPSHOT_CHARS);
    expect(snap.panels[0]!.tabs[0]!.title.length).toBeLessThanOrEqual(MAX_SNAPSHOT_TITLE_CHARS);
    expect(snap.panels[0]!.omittedTabs).toBe(800 - snap.panels[0]!.tabs.length);
    expect(snap.truncated).toContain(`${snap.panels[0]!.omittedTabs} tabs left out`);
  });
});

describe("ui summary", () => {
  it("keeps types and titles of the grid, a visible dock and the windows", () => {
    const summary = buildUiSummary(buildUiStateSnapshot(input({ layout: "phone" })));
    expect(summary).toEqual({
      project: "api",
      layout: "phone",
      panels: [
        { area: "grid", tabs: [{ type: "chat", title: "Fix login" }, { type: "editor", title: "auth.ts", active: true }] },
        { area: "grid", focused: true, tabs: [{ type: "database", title: "users", active: true }] },
        { area: "dock", tabs: [{ type: "terminal", title: "Terminal 1", active: true }] },
      ],
      windows: [{ kind: "tab-host", title: "Landing", state: "normal" }, { kind: "settings", title: "settings", state: "minimized" }],
    });
  });

  it("leaves out a hidden dock and counts tabs past the limit", () => {
    const many = Array.from({ length: 20 }, (_, i) => tab(`t${i}`, "editor", `f${i}`, "api"));
    const summary = buildUiSummary(buildUiStateSnapshot(input({
      panels: { left: panel("left", many), __dock__: panel("__dock__", [tab("term", "terminal", "T", "api")]) },
      grid: [["left"]], dock: { visible: false, height: 30 }, windows: [],
    })));
    expect(summary.panels).toHaveLength(1);
    expect(summary.panels[0]!.tabs).toHaveLength(12);
    expect(summary.panels[0]!.more).toBe(8);
  });
});
