/**
 * The command registry: one list of PPM's commands for the palette, the keyboard and the PPM
 * Assistant. Ids must be unique and fixed, every command must say whether it changes data — the
 * Assistant asks before running one that does — and an extension's command always counts as
 * changing data, since PPM cannot see what it does.
 */
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { installDom, mount, uninstallDom } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);

const { composeCommands, findCommand, listCommands, publishCommandSource } = await import("../../../src/web/lib/commands/command-registry");
const { KEY_ACTIONS, useKeybindingsStore } = await import("../../../src/web/stores/keybindings-store");
const { useTabStore } = await import("../../../src/web/stores/tab-store");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const { useGlobalKeybindings } = await import("../../../src/web/hooks/use-global-keybindings");
const { Plus } = await import("../../../src/web/lib/icons");
const { useDbPaletteCommands } = await import("../../../src/web/components/layout/command-palette-db-commands");
const { useTableEditorCommands } = await import("../../../src/web/components/database/table-editor/table-editor-commands");
const { useDbExplorer } = await import("../../../src/web/components/database/explorer/db-explorer-store");
const { useSettingsStore } = await import("../../../src/web/stores/settings-store");
const { createElement } = await import("react");
type CommandContext = import("../../../src/web/lib/commands/command-registry").CommandContext;
type AppCommand = import("../../../src/web/lib/commands/command-registry").AppCommand;

const extensions = {
  commands: [
    { command: "git.pull", title: "Pull", category: "Git" },
    { command: "notes.add", title: "Add Note" },
  ],
  keybindings: [{ command: "git.pull", key: "Ctrl+Alt+P" }],
};

/** Every combination of the conditions that decide which commands are shown. */
function contexts(): CommandContext[] {
  const out: CommandContext[] = [];
  for (const isMobile of [false, true]) for (const isTouchOnly of [false, true]) for (const lspEnabled of [false, true]) {
    for (const project of [null, { name: "demo", path: "/demo" }]) {
      out.push({ project, isMobile, isTouchOnly, lspEnabled, getBinding: useKeybindingsStore.getState().getBinding, extensions });
    }
  }
  return out;
}

const hookCommand = (id: string, changesData = false): AppCommand => ({ id, label: id, keywords: id, icon: Plus, changesData, run: () => {} });

describe("the command registry", () => {
  it("gives every command a unique id and an explicit changesData, wherever it is listed", () => {
    for (const ctx of contexts()) {
      const all = composeCommands(ctx, { design: [hookCommand("new-design"), hookCommand("design:landing")], db: [hookCommand("db-import-data")] });
      const ids = all.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const cmd of all) {
        expect(typeof cmd.changesData).toBe("boolean");
        expect(cmd.label.length).toBeGreaterThan(0);
        expect(typeof cmd.run).toBe("function");
      }
    }
  });

  it("always counts an extension's command as changing data", () => {
    for (const ctx of contexts()) {
      const ext = composeCommands(ctx, {}).filter((c) => c.id.startsWith("ext:"));
      expect(ext.map((c) => c.id)).toEqual(["ext:git.pull", "ext:notes.add"]);
      for (const cmd of ext) expect(cmd.changesData).toBe(true);
    }
  });

  it("lists built-ins, then designs, then the database's, then extensions", () => {
    const ctx = contexts()[0]!;
    const ids = composeCommands(ctx, { db: [hookCommand("db-x")], design: [hookCommand("design-x")] }).map((c) => c.id);
    expect(ids[0]).toBe("chat");
    expect(ids.slice(-4)).toEqual(["design-x", "db-x", "ext:git.pull", "ext:notes.add"]);
  });

  it("declares the commands that change data or settings, and only those, among its own", () => {
    const ctx = contexts()[0]!;
    const changing = composeCommands(ctx, {}).filter((c) => c.changesData && !c.id.startsWith("ext:")).map((c) => c.id);
    expect(changing).toEqual(["voice-input", "word-wrap", "language-server"]);
  });

  it("counts the table editor's commands as changing data, though each only starts a draft, and the database's others not", async () => {
    useTableEditorCommands.setState({
      owner: "tab-1",
      commands: ["add-column", "add-index", "add-primary-key", "add-foreign-key", "add-unique"].map((id) => ({ id, label: id, run: () => {} })),
    });
    useDbExplorer.setState({ connections: [{ id: 1, type: "postgres", name: "app-dev", readonly: 0 }] as never });
    const settingsBefore = useSettingsStore.getState().dbExplorerView;
    useSettingsStore.setState((s) => ({ dbExplorerView: { ...s.dbExplorerView, current: { conn: 1, database: "shop" } } }));
    let db: AppCommand[] = [];
    function Probe() { db = useDbPaletteCommands(false); return null; }
    const view = await mount(createElement(Probe));
    try {
      expect(db.map((c) => [c.id, c.changesData])).toEqual([
        ["table-editor:add-column", true], ["table-editor:add-index", true], ["table-editor:add-primary-key", true],
        ["table-editor:add-foreign-key", true], ["table-editor:add-unique", true],
        ["db-new-table", false], ["db-export-database", false], ["db-import-data", false],
      ]);
    } finally {
      await view.unmount();
      useTableEditorCommands.setState({ owner: null, commands: [] });
      useDbExplorer.setState({ connections: [] });
      useSettingsStore.setState({ dbExplorerView: settingsBefore });
    }
  });

  it("binds commands only to keybinding actions that exist", () => {
    const known = new Set(KEY_ACTIONS.map((a) => a.id));
    const bound = composeCommands(contexts()[0]!, {}).filter((c) => c.binding);
    expect(bound.map((c) => c.binding)).toEqual(["open-chat", "open-assistant", "new-file", "open-terminal", "voice-input", "open-git-status", "open-problems", "compare-files", "open-settings"]);
    for (const cmd of bound) expect(known.has(cmd.binding!)).toBe(true);
  });

  it("offers the language server toggle only off a touch-only device", () => {
    for (const ctx of contexts()) {
      expect(!!findCommandIn(ctx, "language-server")).toBe(!ctx.isTouchOnly);
    }
  });

  it("serves what a hook published until it withdraws it, and not a list a later run replaced", () => {
    const ctx = contexts()[0]!;
    const first = [hookCommand("db-a")];
    const withdrawFirst = publishCommandSource("db", first);
    expect(findCommand(ctx, "db-a")).toBeDefined();
    const second = [hookCommand("db-b")];
    const withdrawSecond = publishCommandSource("db", second);
    withdrawFirst();
    expect(findCommand(ctx, "db-a")).toBeUndefined();
    expect(findCommand(ctx, "db-b")).toBeDefined();
    withdrawSecond();
    expect(listCommands(ctx).some((c) => c.id === "db-b")).toBe(false);
  });
});

function findCommandIn(ctx: CommandContext, id: string) {
  return composeCommands(ctx, {}).find((c) => c.id === id);
}

describe("the global keybindings", () => {
  it("run the registry's command for a bound key", async () => {
    useProjectStore.setState({ activeProject: { name: "demo", path: "/demo" } as never });
    const openTab = spyOn(useTabStore.getState(), "openTab").mockReturnValue("tab-1");
    function Probe() { useGlobalKeybindings(); return null; }
    const view = await mount(createElement(Probe));
    try {
      // Mod+L, the default for New AI Chat.
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", code: "KeyL", ctrlKey: true, bubbles: true, cancelable: true }));
      expect(openTab).toHaveBeenCalledWith({ type: "chat", title: "AI Chat", projectId: "demo", metadata: { projectName: "demo" }, closable: true });
    } finally {
      await view.unmount();
      openTab.mockRestore();
      useProjectStore.setState({ activeProject: null });
    }
  });
});
