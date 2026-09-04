/**
 * Tests for the ppm-window-panels blob: round trip, and what a hostile or corrupt blob
 * is allowed to bring back.
 *
 * The blob is attacker-controllable localStorage, and what it names ends up mounted in a
 * floating window — so an unknown tab type, a non-window panel id, or a tab type that can
 * never be detached must all be dropped rather than trusted.
 */
import { describe, it, expect, beforeEach } from "bun:test";

const memStore: Record<string, string> = {};
let failWrites = false;
const localStorageStub = {
  getItem: (key: string) => memStore[key] ?? null,
  setItem: (key: string, value: string) => {
    if (failWrites) throw new Error("QuotaExceededError");
    memStore[key] = value;
  },
  removeItem: (key: string) => { delete memStore[key]; },
  clear: () => { for (const k of Object.keys(memStore)) delete memStore[k]; },
};
(globalThis as unknown as { localStorage: typeof localStorageStub }).localStorage = localStorageStub;

import {
  loadWindowPanels,
  saveWindowPanels,
  clearWindowPanels,
} from "../../../src/web/stores/window-panel-persistence";
import { windowPanelId } from "../../../src/web/stores/panel-utils";
import type { Panel } from "../../../src/web/stores/panel-utils";

const KEY = "ppm-window-panels";
const WIN_PANEL = windowPanelId("win-1");

function windowPanel(tabs: { id: string; type: string }[], activeTabId?: string): Panel {
  return {
    id: WIN_PANEL,
    tabs: tabs.map((t) => ({
      id: t.id,
      type: t.type as Panel["tabs"][number]["type"],
      title: t.id,
      projectId: "proj1",
      closable: true,
    })),
    activeTabId: activeTabId ?? tabs[0]?.id ?? null,
    tabHistory: tabs.map((t) => t.id),
  };
}

beforeEach(() => {
  localStorageStub.clear();
  failWrites = false;
});

describe("saveWindowPanels / loadWindowPanels", () => {
  it("round-trips a window panel", () => {
    saveWindowPanels({ [WIN_PANEL]: windowPanel([{ id: "terminal:1", type: "terminal" }]) });

    const loaded = loadWindowPanels();
    expect(Object.keys(loaded)).toEqual([WIN_PANEL]);
    expect(loaded[WIN_PANEL]?.tabs.map((t) => t.id)).toEqual(["terminal:1"]);
    expect(loaded[WIN_PANEL]?.activeTabId).toBe("terminal:1");
  });

  it("saves only window panels, never grid or dock panels", () => {
    saveWindowPanels({
      "panel-A": { id: "panel-A", tabs: [], activeTabId: null, tabHistory: [] },
      __dock__: { id: "__dock__", tabs: [], activeTabId: null, tabHistory: [] },
      [WIN_PANEL]: windowPanel([{ id: "chat:p/1", type: "chat" }]),
    });

    expect(Object.keys(JSON.parse(localStorageStub.getItem(KEY)!))).toEqual([WIN_PANEL]);
  });

  it("removes the key instead of storing an empty map", () => {
    saveWindowPanels({ [WIN_PANEL]: windowPanel([{ id: "terminal:1", type: "terminal" }]) });
    saveWindowPanels({ [WIN_PANEL]: windowPanel([]) });

    expect(localStorageStub.getItem(KEY)).toBeNull();
    expect(loadWindowPanels()).toEqual({});
  });

  it("swallows a storage failure instead of blocking the move", () => {
    failWrites = true;
    expect(() => saveWindowPanels({ [WIN_PANEL]: windowPanel([{ id: "terminal:1", type: "terminal" }]) })).not.toThrow();
  });

  it("ignores a malformed blob", () => {
    memStore[KEY] = "{not json";
    expect(loadWindowPanels()).toEqual({});

    memStore[KEY] = JSON.stringify(["an", "array"]);
    expect(loadWindowPanels()).toEqual({});
  });

  it("drops entries whose key is not a window panel id", () => {
    memStore[KEY] = JSON.stringify({
      "panel-A": { tabs: [{ id: "terminal:1", type: "terminal", title: "t" }] },
    });

    expect(loadWindowPanels()).toEqual({});
  });

  it("drops a tab type that can never be detached, and unknown types", () => {
    memStore[KEY] = JSON.stringify({
      [WIN_PANEL]: {
        tabs: [
          { id: "system-monitor:1", type: "system-monitor", title: "monitor" },
          { id: "evil:1", type: "definitely-not-a-tab", title: "evil" },
          { id: "terminal:1", type: "terminal", title: "term" },
        ],
      },
    });

    expect(loadWindowPanels()[WIN_PANEL]?.tabs.map((t) => t.id)).toEqual(["terminal:1"]);
  });

  it("drops a panel whose tabs are all rejected", () => {
    memStore[KEY] = JSON.stringify({
      [WIN_PANEL]: { tabs: [{ id: "system-monitor:1", type: "system-monitor", title: "m" }] },
    });

    expect(loadWindowPanels()).toEqual({});
  });

  it("repairs an active tab id and history that point at dropped tabs", () => {
    memStore[KEY] = JSON.stringify({
      [WIN_PANEL]: {
        tabs: [{ id: "terminal:1", type: "terminal", title: "term" }],
        activeTabId: "system-monitor:1",
        tabHistory: ["system-monitor:1", "terminal:1"],
      },
    });

    const loaded = loadWindowPanels();
    expect(loaded[WIN_PANEL]?.activeTabId).toBe("terminal:1");
    expect(loaded[WIN_PANEL]?.tabHistory).toEqual(["terminal:1"]);
  });

  it("clears the key on request", () => {
    saveWindowPanels({ [WIN_PANEL]: windowPanel([{ id: "terminal:1", type: "terminal" }]) });
    clearWindowPanels();
    expect(loadWindowPanels()).toEqual({});
  });
});
