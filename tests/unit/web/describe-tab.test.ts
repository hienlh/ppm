/**
 * The device half of `ui_read_tab`: a tab is described with only its allow-listed metadata,
 * an editor's text goes along only when it holds unsaved changes (or was never saved), a
 * database tab's rows are capped, and none of it ever reaches the per-message screen summary.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { installDom, uninstallDom } from "../../helpers/react-dom";

installDom();
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const initialPanels = usePanelStore.getState();
afterAll(() => {
  usePanelStore.setState(initialPanels, true);
  localStorage.clear();
  uninstallDom();
});
const { describeTab, describeTabFrom, capShownRows } = await import("../../../src/web/lib/assistant-ui/describe-tab");
const { registerTabLiveContent } = await import("../../../src/web/lib/assistant-ui/tab-live-content");
const { buildUiStateSnapshot } = await import("../../../src/web/lib/assistant-ui/ui-state-snapshot");
const { buildUiSummary } = await import("../../../src/web/lib/assistant-ui/ui-summary");
const { READ_TAB_DB_CELL_CHARS, READ_TAB_DB_ROWS } = await import("../../../src/shared/assistant-tab-content");

const tab = (id: string, type: string, metadata: Record<string, unknown>, projectId: string | null = "api") =>
  ({ id, type, title: id, projectId, closable: true, metadata }) as any;

describe("describing a tab", () => {
  it("passes only the allow-listed metadata, never the working state", () => {
    const desc = describeTabFrom({
      tab: tab("editor:a.ts", "editor", { filePath: "a.ts", projectName: "api", unsavedContent: "secret draft", pendingMessage: "hi" }),
      area: "grid", offset: 0,
    });
    expect(desc).toMatchObject({ id: "editor:a.ts", type: "editor", project: "api", area: "grid", details: { filePath: "a.ts" } });
    expect(JSON.stringify(desc.details)).not.toContain("secret draft");
    expect(desc.editor).toEqual({ untitled: false, special: false, dirty: false, filePath: "a.ts" });
  });

  it("sends an editor's text only while it has unsaved changes", () => {
    const t = tab("editor:a.ts", "editor", { filePath: "a.ts" });
    const clean = describeTabFrom({ tab: t, area: "grid", offset: 0, live: { kind: "editor", dirty: false, text: "saved text" } });
    expect(clean.editor!.unsaved).toBeUndefined();
    const dirty = describeTabFrom({ tab: t, area: "grid", offset: 1, live: { kind: "editor", dirty: true, text: "one\ntwo\nthree" } });
    expect(dirty.editor).toMatchObject({ dirty: true, unsaved: { text: "two\nthree", fromLine: 2, toLine: 3, totalLines: 3 } });
  });

  it("sends an untitled file's text, from the tab when its editor is not mounted", () => {
    const desc = describeTabFrom({ tab: tab("editor:untitled-1", "editor", { isUntitled: true, unsavedContent: "draft" }, null), area: "grid", offset: 0 });
    expect(desc.editor).toMatchObject({ untitled: true, dirty: true, unsaved: { text: "draft" } });
    expect(describeTabFrom({ tab: tab("editor:v", "editor", { viewerKey: "diff:1" }), area: "grid", offset: 0 }).editor!.special).toBe(true);
  });

  it("sends a Query tab's SQL and the rows it shows, capped", () => {
    const rows = Array.from({ length: READ_TAB_DB_ROWS + 50 }, (_, i) => [i, "x".repeat(READ_TAB_DB_CELL_CHARS + 10)]);
    const desc = describeTabFrom({
      tab: tab("db-query:q", "db-query", { connectionId: 3, currentSql: "select * from t" }, null),
      area: "window", offset: 0, live: { kind: "rows", rows: { columns: ["id", "name"], rows, more: false } },
    });
    expect(desc.database!.sql).toBe("select * from t");
    expect(desc.database!.rows!.rows).toHaveLength(READ_TAB_DB_ROWS);
    expect(desc.database!.rows!.more).toBe(true);
    expect(String(desc.database!.rows!.rows[0]![1]).length).toBeLessThan(READ_TAB_DB_CELL_CHARS + 60);
    const unloaded = describeTabFrom({ tab: tab("database:3::public:t", "database", { connectionId: 3, tableName: "t" }, null), area: "grid", offset: 0 });
    expect(unloaded.database).toEqual({});
  });

  it("keeps a wide result within what one answer may carry", () => {
    const long = "y".repeat(2_000);
    const wide = capShownRows({ columns: ["a", "b", "c"], rows: Array.from({ length: 200 }, () => [long, long, long]), more: false });
    expect(wide.rows.length).toBeLessThan(200);
    expect(JSON.stringify(wide.rows).length).toBeLessThanOrEqual(150_000);
    expect(wide.more).toBe(true);
  });
});

describe("describe_tab on this device", () => {
  it("finds the tab, its terminal's shell and its live content", () => {
    usePanelStore.setState({
      currentProject: "api", focusedPanelId: "p1", grid: [["p1"]],
      panels: { p1: { id: "p1", activeTabId: "terminal:1", tabHistory: [], tabs: [tab("terminal:1", "terminal", {}), tab("editor:b.ts", "editor", { filePath: "b.ts" })] } },
    } as never);
    localStorage.setItem("ppm:terminal-session:terminal:1", "0b6f6a3c-1a7b-4d7e-9b1a-2f0f6d8e9c11");
    expect(describeTab({ tabId: "terminal:1" }).terminal).toEqual({ sessionId: "0b6f6a3c-1a7b-4d7e-9b1a-2f0f6d8e9c11" });
    const stop = registerTabLiveContent("editor:b.ts", () => ({ kind: "editor", dirty: true, text: "typed" }));
    try {
      expect(describeTab({ tabId: "editor:b.ts" }).editor!.unsaved!.text).toBe("typed");
    } finally {
      stop();
    }
    expect(describeTab({ tabId: "editor:b.ts" }).editor!.dirty).toBe(false);
    expect(() => describeTab({ tabId: "nope" })).toThrow("ui_get_state");
  });
});

describe("the per-message screen summary", () => {
  it("carries no tab content", () => {
    const panels = {
      p1: {
        id: "p1", activeTabId: "editor:untitled-1", tabHistory: [], tabs: [
          tab("editor:untitled-1", "editor", { isUntitled: true, unsavedContent: "PRIVATE-DRAFT" }, null),
          tab("db-query:q", "db-query", { currentSql: "select PRIVATE_SQL" }, null),
        ],
      },
    };
    const snapshot = buildUiStateSnapshot({
      currentProject: "api", layout: "desktop", panels: panels as never, grid: [["p1"]], focusedPanelId: "p1",
      dock: { visible: false, height: 30 }, dockExpanded: false, windows: [],
    });
    const text = JSON.stringify([snapshot, buildUiSummary(snapshot)]);
    expect(text).not.toContain("PRIVATE-DRAFT");
    expect(text).not.toContain("PRIVATE_SQL");
  });
});
