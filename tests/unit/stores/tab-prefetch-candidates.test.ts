/**
 * Policy tests for idle prefetch candidate selection.
 *
 * The cap and the type restriction are the safety properties: an uncapped or
 * type-blind prefetch would recreate the boot request storm, and prefetching a
 * terminal would spawn a PTY process the user never asked for.
 */
import { describe, it, expect } from "bun:test";
import { pickPrefetchCandidates } from "../../../src/web/components/layout/tab-prefetch";
import type { Panel } from "../../../src/web/stores/panel-utils";

function makePanel(
  id: string,
  tabs: { id: string; type: string }[],
  opts?: { activeTabId?: string; tabHistory?: string[] },
): Panel {
  const builtTabs = tabs.map((t) => ({
    id: t.id,
    type: t.type as Panel["tabs"][number]["type"],
    title: t.id,
    projectId: "proj-1",
    closable: true,
  }));
  return {
    id,
    tabs: builtTabs,
    activeTabId: opts?.activeTabId ?? builtTabs[0]?.id ?? null,
    // Default history is oldest→newest in declaration order.
    tabHistory: opts?.tabHistory ?? builtTabs.map((t) => t.id),
  };
}

const chats = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, type: "chat" }));

describe("pickPrefetchCandidates — cap", () => {
  it("returns at most `cap` ids", () => {
    const panels = { A: makePanel("A", chats("chat:a", 10)) };
    expect(pickPrefetchCandidates(panels, new Set(), 3)).toHaveLength(3);
  });

  it("returns nothing when cap is 0 or negative", () => {
    const panels = { A: makePanel("A", chats("chat:a", 10)) };
    expect(pickPrefetchCandidates(panels, new Set(), 0)).toEqual([]);
    expect(pickPrefetchCandidates(panels, new Set(), -1)).toEqual([]);
  });

  it("returns nothing when every tab is already mounted", () => {
    const panels = { A: makePanel("A", chats("chat:a", 4)) };
    const mounted = new Set(["chat:a0", "chat:a1", "chat:a2", "chat:a3"]);
    expect(pickPrefetchCandidates(panels, mounted, 3)).toEqual([]);
  });

  it("returns nothing for an empty panel map", () => {
    expect(pickPrefetchCandidates({}, new Set(), 3)).toEqual([]);
  });
});

describe("pickPrefetchCandidates — recency", () => {
  it("prefers the most recently used tabs (tabHistory tail first)", () => {
    const panels = {
      A: makePanel("A", chats("chat:a", 5), {
        tabHistory: ["chat:a0", "chat:a1", "chat:a2", "chat:a3", "chat:a4"],
      }),
    };
    expect(pickPrefetchCandidates(panels, new Set(), 3)).toEqual(["chat:a4", "chat:a3", "chat:a2"]);
  });

  it("skips mounted tabs but keeps recency order for the rest", () => {
    const panels = {
      A: makePanel("A", chats("chat:a", 5), {
        tabHistory: ["chat:a0", "chat:a1", "chat:a2", "chat:a3", "chat:a4"],
      }),
    };
    const mounted = new Set(["chat:a4", "chat:a2"]);
    expect(pickPrefetchCandidates(panels, mounted, 3)).toEqual(["chat:a3", "chat:a1", "chat:a0"]);
  });

  it("ignores duplicate entries in tabHistory", () => {
    const panels = {
      A: makePanel("A", chats("chat:a", 3), {
        tabHistory: ["chat:a0", "chat:a1", "chat:a0", "chat:a2", "chat:a0"],
      }),
    };
    expect(pickPrefetchCandidates(panels, new Set(), 3)).toEqual(["chat:a0", "chat:a2", "chat:a1"]);
  });

  it("ignores history ids that are no longer real tabs", () => {
    const panels = {
      A: makePanel("A", chats("chat:a", 2), {
        tabHistory: ["chat:closed", "chat:a0", "chat:a1"],
      }),
    };
    expect(pickPrefetchCandidates(panels, new Set(), 3)).toEqual(["chat:a1", "chat:a0"]);
  });
});

describe("pickPrefetchCandidates — tab types", () => {
  it("never prefetches terminals (mounting one would spawn a PTY)", () => {
    const panels = {
      A: makePanel("A", [
        { id: "terminal:1", type: "terminal" },
        { id: "terminal:2", type: "terminal" },
      ]),
    };
    expect(pickPrefetchCandidates(panels, new Set(), 3)).toEqual([]);
  });

  it("skips editor, database and settings tabs, keeping only chat", () => {
    const panels = {
      A: makePanel("A", [
        { id: "chat:keep", type: "chat" },
        { id: "editor:/a.ts", type: "editor" },
        { id: "database:x", type: "database" },
        { id: "settings:1", type: "settings" },
        { id: "terminal:9", type: "terminal" },
      ]),
    };
    expect(pickPrefetchCandidates(panels, new Set(), 5)).toEqual(["chat:keep"]);
  });
});

describe("pickPrefetchCandidates — split panels", () => {
  it("shares the budget round-robin so one panel cannot consume it all", () => {
    const panels = {
      A: makePanel("A", chats("chat:a", 10), {
        tabHistory: Array.from({ length: 10 }, (_, i) => `chat:a${i}`),
      }),
      B: makePanel("B", chats("chat:b", 2), { tabHistory: ["chat:b0", "chat:b1"] }),
    };
    // Round 0 takes the newest from each panel, round 1 the next newest.
    expect(pickPrefetchCandidates(panels, new Set(), 3)).toEqual(["chat:a9", "chat:b1", "chat:a8"]);
  });

  it("falls back to the remaining panel once the other is exhausted", () => {
    const panels = {
      A: makePanel("A", chats("chat:a", 5), {
        tabHistory: ["chat:a0", "chat:a1", "chat:a2", "chat:a3", "chat:a4"],
      }),
      B: makePanel("B", chats("chat:b", 1), { tabHistory: ["chat:b0"] }),
    };
    expect(pickPrefetchCandidates(panels, new Set(), 4)).toEqual([
      "chat:a4",
      "chat:b0",
      "chat:a3",
      "chat:a2",
    ]);
  });

  it("does not return the same tab id twice when it appears in two panels", () => {
    const panels = {
      A: makePanel("A", [{ id: "chat:shared", type: "chat" }], { tabHistory: ["chat:shared"] }),
      B: makePanel("B", [{ id: "chat:shared", type: "chat" }], { tabHistory: ["chat:shared"] }),
    };
    expect(pickPrefetchCandidates(panels, new Set(), 3)).toEqual(["chat:shared"]);
  });
});
