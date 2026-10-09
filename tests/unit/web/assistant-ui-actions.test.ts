/**
 * The PPM Assistant's navigation on the device: the tab each `kind` opens, brought forward
 * rather than opened twice, the project switched first so the tab can be seen, the Assistant
 * carried along onto a phone's new grid, and a tab holding unsaved work left open.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { installDom, uninstallDom } from "../../helpers/react-dom";

installDom();
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const initialPanels = usePanelStore.getState();
const initialProjects = useProjectStore.getState();
afterAll(() => {
  usePanelStore.setState(initialPanels, true);
  useProjectStore.setState(initialProjects, true);
  localStorage.clear();
  uninstallDom();
});
const { buildAssistantTabDef } = await import("../../../src/web/lib/assistant-ui/assistant-tab-def");
const { openAssistantTab, focusAssistantTab, switchAssistantProject, closeAssistantTab } =
  await import("../../../src/web/lib/assistant-ui/assistant-ui-actions");
const { registerTabLiveContent } = await import("../../../src/web/lib/assistant-ui/tab-live-content");
const { ASSISTANT_TAB_ID } = await import("../../../src/web/components/assistant/open-assistant");

type AnyTab = { id: string; type: string; title: string; projectId: string | null; closable: boolean; metadata?: Record<string, unknown> };
const tab = (id: string, type: string, projectId: string | null, metadata: Record<string, unknown> = {}): AnyTab =>
  ({ id, type, title: id, projectId, closable: true, metadata });
const assistant = () => tab(ASSISTANT_TAB_ID, "assistant", null, { projectName: "__assistant__", sessionId: "S1" });
const panel = (id: string, tabs: AnyTab[]) => ({ id, tabs, activeTabId: tabs[0]?.id ?? null, tabHistory: tabs.map((t) => t.id) });

function seed(opts: { mobile?: boolean; a?: AnyTab[]; b?: AnyTab[] } = {}) {
  localStorage.clear();
  useProjectStore.setState({ projects: [{ name: "a", path: "/a" }, { name: "b", path: "/b" }] } as never);
  const a1 = panel("a1", opts.a ?? [assistant()]);
  const b1 = panel("b1", opts.b ?? [tab("editor:b.ts", "editor", "b", { filePath: "b.ts", projectName: "b" })]);
  localStorage.setItem("ppm-panels-b", JSON.stringify({ panels: { b1 }, grid: [["b1"]], focusedPanelId: "b1" }));
  usePanelStore.setState({
    currentProject: "a", focusedPanelId: "a1", grid: [["a1"]], lastFocusedChatProviders: {},
    projectGrids: { a: [["a1"]], b: [["b1"]] }, projectFocused: { a: "a1", b: "b1" },
    panels: { a1, b1 }, isMobile: () => opts.mobile ?? false,
  } as never);
}
const allTabs = () => Object.values(usePanelStore.getState().panels).flatMap((p) => p.tabs);
const chat = { sessionId: "S1" };

describe("the tab each kind opens", () => {
  it("names a chat by its session and finds it by session, a new chat by nothing", () => {
    const def = buildAssistantTabDef({ kind: "chat", sessionId: "X", providerId: "codex", title: "Fix" }, "a");
    expect(def.tab).toMatchObject({ type: "chat", title: "Fix", projectId: "a", metadata: { projectName: "a", sessionId: "X", providerId: "codex" } });
    expect(def.matches(tab("chat:random", "chat", "a", { sessionId: "X" }))).toBe(true);
    expect(def.matches(tab("design:x", "design", "a", { sessionId: "X" }))).toBe(true);
    expect(buildAssistantTabDef({ kind: "chat" }, "a").matches(tab("chat:y", "chat", "a", {}))).toBe(false);
  });

  it("opens a terminal and a Query tab new every time, a table on its one tab", () => {
    expect(buildAssistantTabDef({ kind: "terminal" }, "a").tab).toMatchObject({ type: "terminal", projectId: "a" });
    const db = { kind: "database" as const, connectionId: 7, connectionName: "main", dbType: "postgres" };
    const query = buildAssistantTabDef(db, "a", { queryNumber: 3 });
    expect(query.tab).toMatchObject({ type: "db-query", title: "Query 3", projectId: null, metadata: { connectionId: 7, currentSql: "" } });
    const table = buildAssistantTabDef({ ...db, schema: "public", table: "users" }, "a");
    expect(table.tab).toMatchObject({ type: "database", title: "main · users", metadata: { connectionId: 7, schemaName: "public", tableName: "users" } });
    expect(table.matches(tab("database:7::public:users", "database", null))).toBe(true);
    expect(table.matches(tab("database:7::public:orders", "database", null))).toBe(false);
  });

  it("tells two projects' files of one path apart", () => {
    const def = buildAssistantTabDef({ kind: "file", filePath: "src/x.ts", projectName: "a" }, "a");
    expect(def.tab).toMatchObject({ type: "editor", title: "x.ts", projectId: "a" });
    expect(def.matches(tab("editor:src/x.ts", "editor", "a", { filePath: "src/x.ts", projectName: "a" }))).toBe(true);
    expect(def.matches(tab("editor:src/x.ts", "editor", "b", { filePath: "src/x.ts", projectName: "b" }))).toBe(false);
  });

  it("opens git and settings on their one tab", () => {
    expect(buildAssistantTabDef({ kind: "git", view: "review" }, "a").tab).toMatchObject({ type: "git-review", metadata: { projectName: "a" } });
    const log = buildAssistantTabDef({ kind: "git", view: "log" }, "a");
    expect(log.matches(tab("git-log:zz", "git-log", "a"))).toBe(true);
    expect(log.matches(tab("git-log:zz", "git-log", "b"))).toBe(false);
    expect(buildAssistantTabDef({ kind: "settings", section: "voice" }, "a").tab).toMatchObject({ type: "settings", metadata: { category: "voice" } });
  });
});

describe("opening, focusing and switching", () => {
  beforeEach(() => seed());

  it("switches to the tab's project first and answers the project it left", () => {
    const res = openAssistantTab({ project: "b", target: { kind: "git", view: "review" } }, chat);
    expect(res).toMatchObject({ tabId: "git-review:b", project: "b", previousProject: "a" });
    expect(usePanelStore.getState().currentProject).toBe("b");
    expect(usePanelStore.getState().grid.flat()).toContain(usePanelStore.getState().getPanelForTab("git-review:b")!.id);
  });

  it("brings an open tab forward instead of opening a second", () => {
    seed({ a: [assistant(), tab("chat:claude/abc", "chat", "a", { projectName: "a", sessionId: "abc", providerId: "claude" })] });
    const res = openAssistantTab({ project: "a", target: { kind: "chat", sessionId: "abc", providerId: "claude" } }, chat);
    expect(res).toMatchObject({ tabId: "chat:claude/abc", previousProject: "a", project: "a" });
    expect(allTabs().filter((t) => t.type === "chat")).toHaveLength(1);
    openAssistantTab({ project: "a", target: { kind: "git", view: "review" } }, chat);
    openAssistantTab({ project: "a", target: { kind: "git", view: "review" } }, chat);
    expect(allTabs().filter((t) => t.type === "git-review")).toHaveLength(1);
  });

  it("refuses a project this device does not have, and the Assistant's own", () => {
    expect(() => openAssistantTab({ project: "nope", target: { kind: "terminal" } }, chat)).toThrow("no project named");
    expect(() => switchAssistantProject({ project: "__assistant__" })).toThrow("registered projects");
    expect(() => openAssistantTab({ project: "a", target: { kind: "shell" } }, chat)).toThrow("Unknown tab kind");
    expect(usePanelStore.getState().currentProject).toBe("a");
  });

  it("switches project and back with previousProject", () => {
    const there = switchAssistantProject({ project: "b" });
    expect(there).toEqual({ tabId: null, project: "b", previousProject: "a" });
    expect(switchAssistantProject({ project: there.previousProject })).toMatchObject({ project: "a", previousProject: "b" });
  });

  it("focuses a tab of a project that is not showing by switching to it", () => {
    const res = focusAssistantTab({ tabId: "editor:b.ts" });
    expect(res).toEqual({ tabId: "editor:b.ts", project: "b", previousProject: "a" });
    expect(() => focusAssistantTab({ tabId: "missing" })).toThrow("ui_get_state");
  });

  it("on a phone, carries the Assistant onto the new project's grid behind the opened tab", () => {
    seed({ mobile: true });
    openAssistantTab({ project: "b", target: { kind: "terminal" } }, chat);
    const store = usePanelStore.getState();
    const shown = store.grid.flat().map((id) => store.panels[id]!);
    expect(shown.flatMap((p) => p.tabs.map((t) => t.id))).toContain(ASSISTANT_TAB_ID);
    expect(store.panels.a1!.tabs.map((t) => t.id)).not.toContain(ASSISTANT_TAB_ID);
    expect(store.panels[shown[0]!.id]!.activeTabId).toMatch(/^terminal:/);
  });
});

describe("closing", () => {
  it("closes a tab with nothing unsaved and answers enough to open it again", () => {
    seed({ a: [assistant(), tab("editor:x.ts", "editor", "a", { filePath: "x.ts", projectName: "a" })] });
    const res = closeAssistantTab({ tabId: "editor:x.ts" });
    expect(res).toEqual({ closed: true, tabId: "editor:x.ts", project: "a", closedTab: { type: "editor", title: "editor:x.ts", project: "a", details: { filePath: "x.ts" } } });
    expect(allTabs().map((t) => t.id)).not.toContain("editor:x.ts");
  });

  it("leaves a tab holding unsaved work open and says it needs approval", () => {
    seed({
      a: [
        assistant(),
        tab("db-query:q", "db-query", null, { currentSql: "select 1", openedSql: "" }),
        tab("editor:untitled-1", "editor", null, { isUntitled: true, unsavedContent: "draft" }),
        tab("editor:y.ts", "editor", "a", { filePath: "y.ts", projectName: "a" }),
        tab("terminal:1", "terminal", "a"),
      ],
    });
    const stop = registerTabLiveContent("editor:y.ts", () => ({ kind: "editor", dirty: true, text: "typed" }));
    try {
      for (const id of ["db-query:q", "editor:untitled-1", "editor:y.ts", "terminal:1"]) {
        const res = closeAssistantTab({ tabId: id });
        expect(res.closed).toBe(false);
        if (!res.closed) expect(res.needsApproval.reason.length).toBeGreaterThan(10);
        expect(allTabs().map((t) => t.id)).toContain(id);
      }
    } finally {
      stop();
    }
    expect(closeAssistantTab({ tabId: "editor:y.ts" }).closed).toBe(true);
  });

  it("never closes the Assistant's own tab", () => {
    seed();
    expect(() => closeAssistantTab({ tabId: ASSISTANT_TAB_ID })).toThrow("Assistant's own tab");
  });
});
