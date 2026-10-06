import { describe, expect, test } from "bun:test";
import {
  chooseAiTabPlacement, isTabForFile, type AiTabPlacementInput, type PlacementPanel, type PlacementTab,
} from "../../../src/web/lib/ai-tab-placement";

const SESSION = "s-1";
const chat: PlacementTab = { id: "chat:claude/s-1", type: "chat", metadata: { sessionId: SESSION } };
const file = (filePath: string, projectName = "app"): PlacementTab => ({ id: `editor:${filePath}`, type: "editor", metadata: { filePath, projectName } });
const panel = (id: string, tabs: PlacementTab[], activeTabId = tabs[0]?.id ?? null): PlacementPanel => ({ id, tabs, activeTabId });

function input(panels: PlacementPanel[], grid: string[][], extra: Partial<AiTabPlacementInput> = {}): AiTabPlacementInput {
  return {
    grid,
    panels: Object.fromEntries(panels.map((p) => [p.id, p])),
    focusedPanelId: grid[0]![0]!,
    mobile: false,
    sessionId: SESSION,
    isTarget: (t) => isTabForFile(t, "report.html", "app"),
    ...extra,
  };
}

describe("chooseAiTabPlacement", () => {
  test("one panel: the file opens in the chat's panel and is split out to its right", () => {
    expect(chooseAiTabPlacement(input([panel("p1", [chat])], [["p1"]]))).toEqual({ kind: "open", panelId: "p1", split: true });
  });

  test("two panels: the file opens in the one that is not the chat's", () => {
    const panels = [panel("p1", [chat]), panel("p2", [file("a.ts")])];
    expect(chooseAiTabPlacement(input(panels, [["p1", "p2"]]))).toEqual({ kind: "open", panelId: "p2", split: false });
    // The chat on the right: its left neighbour.
    expect(chooseAiTabPlacement(input(panels, [["p2", "p1"]], { focusedPanelId: "p1" }))).toEqual({ kind: "open", panelId: "p2", split: false });
  });

  test("the right neighbour wins over a panel in another row, and the focused panel over both", () => {
    const panels = [panel("p1", [chat]), panel("p2", []), panel("p3", [])];
    expect(chooseAiTabPlacement(input(panels, [["p3"], ["p1", "p2"]], { focusedPanelId: "p1" }))).toEqual({ kind: "open", panelId: "p2", split: false });
    expect(chooseAiTabPlacement(input(panels, [["p3"], ["p1", "p2"]], { focusedPanelId: "p3" }))).toEqual({ kind: "open", panelId: "p3", split: false });
  });

  test("a tab already showing the file in another panel is brought to the front", () => {
    const panels = [panel("p1", [chat]), panel("p2", [file("a.ts"), file("report.html")])];
    expect(chooseAiTabPlacement(input(panels, [["p1", "p2"]]))).toEqual({ kind: "focus", tabId: "editor:report.html", panelId: "p2" });
  });

  test("a tab hidden behind the chat is moved out beside it, never shown over it", () => {
    const behind = panel("p1", [chat, file("report.html")], chat.id);
    expect(chooseAiTabPlacement(input([behind], [["p1"]])))
      .toEqual({ kind: "move", tabId: "editor:report.html", fromPanelId: "p1", toPanelId: null });
    expect(chooseAiTabPlacement(input([behind, panel("p2", [])], [["p1", "p2"]])))
      .toEqual({ kind: "move", tabId: "editor:report.html", fromPanelId: "p1", toPanelId: "p2" });
  });

  test("when the chat is not the tab on screen in its panel, the file's tab there is just focused", () => {
    const panels = [panel("p1", [chat, file("report.html"), file("a.ts")], "editor:a.ts")];
    expect(chooseAiTabPlacement(input(panels, [["p1"]]))).toEqual({ kind: "focus", tabId: "editor:report.html", panelId: "p1" });
  });

  test("a copy outside the chat's panel is preferred over one behind the chat", () => {
    const panels = [panel("p1", [chat, file("report.html")], chat.id), panel("p2", [file("report.html")])];
    expect(chooseAiTabPlacement(input(panels, [["p1", "p2"]]))).toEqual({ kind: "focus", tabId: "editor:report.html", panelId: "p2" });
  });

  test("phone: the first panel, which then shows the tab; an open tab is reused wherever it is", () => {
    const panels = [panel("p1", [chat]), panel("p2", [])];
    expect(chooseAiTabPlacement(input(panels, [["p1", "p2"]], { mobile: true, focusedPanelId: "p2" })))
      .toEqual({ kind: "open", panelId: "p1", split: false });
    const open = [panel("p1", [chat]), panel("p2", [file("report.html")])];
    expect(chooseAiTabPlacement(input(open, [["p1", "p2"]], { mobile: true })))
      .toEqual({ kind: "focus", tabId: "editor:report.html", panelId: "p2" });
  });

  test("a chat in a floating window: the focused grid panel, no split", () => {
    const panels = [panel("p1", [file("a.ts")]), panel("p2", [])];
    expect(chooseAiTabPlacement(input(panels, [["p1", "p2"]], { focusedPanelId: "p2" }))).toEqual({ kind: "open", panelId: "p2", split: false });
    expect(chooseAiTabPlacement(input(panels, [["p1", "p2"]], { focusedPanelId: "win:1" }))).toEqual({ kind: "open", panelId: "p1", split: false });
  });

  test("a design tab hosting the session is the chat", () => {
    const design: PlacementTab = { id: "design:x", type: "design", metadata: { sessionId: SESSION } };
    expect(chooseAiTabPlacement(input([panel("p1", [design])], [["p1"]]))).toEqual({ kind: "open", panelId: "p1", split: true });
  });

  test("no panel on the grid: nowhere to open", () => {
    expect(chooseAiTabPlacement(input([], [["gone"]]))).toBeNull();
  });
});

describe("isTabForFile", () => {
  test("a relative path matches only in the same project", () => {
    expect(isTabForFile(file("src/a.ts", "app"), "src/a.ts", "app")).toBe(true);
    expect(isTabForFile(file("src/a.ts", "other"), "src/a.ts", "app")).toBe(false);
  });

  test("an absolute path matches whatever project the tab was opened from", () => {
    expect(isTabForFile({ id: "editor:/tmp/r.html", type: "editor", metadata: { filePath: "/tmp/r.html" } }, "/tmp/r.html", null)).toBe(true);
    expect(isTabForFile(file("C:\\x\\r.html", "app"), "C:\\x\\r.html", null)).toBe(true);
  });

  test("untitled buffers, inline viewers and other tab types never match", () => {
    expect(isTabForFile({ id: "x", type: "editor", metadata: { filePath: "a.ts", projectName: "app", isUntitled: true } }, "a.ts", "app")).toBe(false);
    expect(isTabForFile({ id: "x", type: "editor", metadata: { filePath: "a.ts", projectName: "app", viewerKey: "k" } }, "a.ts", "app")).toBe(false);
    expect(isTabForFile({ id: "x", type: "editor", metadata: { filePath: "a.ts", projectName: "app", inlineContent: "" } }, "a.ts", "app")).toBe(false);
    expect(isTabForFile({ id: "x", type: "git-diff", metadata: { filePath: "a.ts", projectName: "app" } }, "a.ts", "app")).toBe(false);
  });
});
