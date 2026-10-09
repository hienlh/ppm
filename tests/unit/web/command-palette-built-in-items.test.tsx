/**
 * The palette's action list, row by row — label, hint, shortcut, order and the group chips —
 * as the palette rendered it before its actions moved into the command registry. Every entry
 * the palette offers is now built from that registry, so a slip in the move (an entry lost, a
 * shortcut gone, two entries swapped, a visibility condition inverted) shows up here as a
 * changed row rather than as a palette that merely looks a little different.
 *
 * Four devices: a desktop with nothing open, a desktop with a project, extensions, a database
 * and the table editor in front, a phone, and a touch-only tablet as wide as a desktop.
 */
import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount } from "../../helpers/react-dom";

installDom();
const { CommandPalette } = await import("../../../src/web/components/layout/command-palette");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const { useSettingsStore } = await import("../../../src/web/stores/settings-store");
const { useExtensionStore } = await import("../../../src/web/stores/extension-store");
const { useDbExplorer } = await import("../../../src/web/components/database/explorer/db-explorer-store");
const { useFileStore } = await import("../../../src/web/stores/file-store");
const { useTableEditorCommands } = await import("../../../src/web/components/database/table-editor/table-editor-commands");
const apiClient = await import("../../../src/web/lib/api-client");

const realWidth = window.innerWidth;
const realMatchMedia = window.matchMedia;
const settingsBefore = useSettingsStore.getState();
afterAll(uninstallDom);
afterEach(() => {
  Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true });
  window.matchMedia = realMatchMedia;
  useProjectStore.setState({ activeProject: null });
  useExtensionStore.setState({ contributions: null });
  useTableEditorCommands.setState({ owner: null, commands: [] });
  useDbExplorer.setState({ connections: [] });
  useFileStore.setState({ fileIndex: [], indexStatus: "idle", indexProject: null });
  useSettingsStore.setState(settingsBefore, true);
});

interface Row { label: string; hint?: string; shortcut?: string }

/** Every rendered result row of the palette opened with no query, plus its group chips. */
async function render(): Promise<{ rows: Row[]; chips: string[] }> {
  const get = spyOn(apiClient.api, "get").mockImplementation(async (url: string) => {
    if (url.includes("/designs")) return { designs: [{ slug: "landing", title: "Landing page", kind: "page" }], systems: [] } as never;
    return [] as never;
  });
  const view = await mount(<CommandPalette open onClose={() => {}} />);
  // The design list arrives after the first paint.
  const { act } = await import("react");
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  try {
    const list = view.container.querySelector(".max-h-72")!;
    const rows = [...list.querySelectorAll("button")].map((b) => {
      const spans = b.querySelectorAll(":scope > span");
      const hint = spans[1]?.textContent ?? undefined;
      const shortcut = b.querySelector(":scope > kbd")?.textContent ?? undefined;
      return {
        label: spans[0]?.textContent ?? "",
        ...(hint ? { hint } : {}),
        ...(shortcut ? { shortcut } : {}),
      };
    });
    const chips = [...view.container.querySelectorAll("button")]
      .filter((b) => !list.contains(b))
      .map((b) => b.textContent ?? "")
      .filter(Boolean);
    return { rows, chips };
  } finally {
    await view.unmount();
    get.mockRestore();
  }
}

const setWidth = (value: number) => Object.defineProperty(window, "innerWidth", { value, configurable: true });

function busyDesktop() {
  setWidth(1280);
  useProjectStore.setState({ activeProject: { name: "demo", path: "/demo" } as never });
  useSettingsStore.setState({
    lspEnabled: true,
    dbExplorerView: { ...useSettingsStore.getState().dbExplorerView, current: { conn: 1, database: "shop" } } as never,
  });
  useDbExplorer.setState({ connections: [{ id: 1, type: "postgres", name: "app-dev", readonly: 0 }] as never });
  // A file, so the palette has a second group and shows its chips: every row counted as an action.
  useFileStore.setState({ fileIndex: [{ name: "a.ts", path: "a.ts", type: "file" }] as never, indexStatus: "ready", indexProject: "demo" });
  useTableEditorCommands.setState({
    owner: "tab-1",
    commands: [{ id: "add-column", label: "Add column", run: () => {} }, { id: "add-index", label: "Add index", run: () => {} }],
  });
  useExtensionStore.setState({
    contributions: {
      commands: [
        { command: "git-graph.view", title: "View Git Graph", category: "Git Graph" },
        { command: "notes.add", title: "Add Note" },
      ],
      keybindings: [{ command: "git-graph.view", key: "Ctrl+Shift+G" }],
    } as never,
  });
}

it.each([
  ["an empty desktop", () => setWidth(1280)],
  ["a busy desktop", busyDesktop],
  ["a phone", () => { busyDesktop(); setWidth(390); }],
  ["a touch-only tablet", () => {
    busyDesktop();
    window.matchMedia = ((q: string) => ({ matches: q.includes("pointer: coarse"), media: q, addEventListener() {}, removeEventListener() {} })) as never;
  }],
] as const)("lists the same actions on %s", async (name, setup) => {
  setup();
  const actual = await render();
  expect(actual).toEqual(EXPECTED[name]);
});

/** Captured from the palette before the move, unchanged since. */
const EXPECTED: Record<string, { rows: Row[]; chips: string[] }> = {
  "an empty desktop": {
    rows: [
      { label: "New AI Chat", shortcut: "Ctrl+L" },
      { label: "PPM Assistant" },
      { label: "New File", shortcut: "Ctrl+N" },
      { label: "New DB Query" },
      { label: "New Terminal" },
      { label: "Remote Access" },
      { label: "Forward a Port" },
      { label: "PPM Cloud & Share" },
      { label: "New connection…" },
      { label: "Voice Input", shortcut: "Ctrl+Shift+V" },
      { label: "Git Status", shortcut: "Ctrl+Shift+E" },
      { label: "Problems", shortcut: "Ctrl+Shift+M" },
      { label: "Toggle Word Wrap", shortcut: "Alt+Z" },
      { label: "Compare Files...", shortcut: "Ctrl+Alt+D" },
      { label: "Turn On Language Server", hint: "This device" },
      { label: "Settings", shortcut: "Ctrl+," },
      { label: "Open File Explorer" },
      { label: "System Monitor" },
      { label: "Logs" },
      { label: "Report a Bug" },
      { label: "Export database" },
      { label: "Import data" },
    ],
    chips: [],
  },
  "a busy desktop": {
    rows: [
      { label: "New AI Chat", shortcut: "Ctrl+L" },
      { label: "PPM Assistant" },
      { label: "New File", shortcut: "Ctrl+N" },
      { label: "New DB Query" },
      { label: "New Terminal" },
      { label: "Remote Access" },
      { label: "Forward a Port" },
      { label: "PPM Cloud & Share" },
      { label: "New connection…" },
      { label: "Voice Input", shortcut: "Ctrl+Shift+V" },
      { label: "Git Status", shortcut: "Ctrl+Shift+E" },
      { label: "Problems", shortcut: "Ctrl+Shift+M" },
      { label: "Toggle Word Wrap", shortcut: "Alt+Z" },
      { label: "Compare Files...", shortcut: "Ctrl+Alt+D" },
      { label: "Turn Off Language Server", hint: "This device" },
      { label: "Settings", shortcut: "Ctrl+," },
      { label: "Open File Explorer" },
      { label: "System Monitor" },
      { label: "Logs" },
      { label: "Report a Bug" },
      { label: "New Design…" },
      { label: "Designs" },
      { label: "Open Design: Landing page", hint: "designs/landing" },
      { label: "Add column", hint: "Table editor" },
      { label: "Add index", hint: "Table editor" },
      { label: "New table" },
      { label: "Export database" },
      { label: "Import data" },
      { label: "View Git Graph", hint: "Git Graph", shortcut: "Ctrl+Shift+G" },
      { label: "Add Note" },
    ],
    chips: ["Actions(30)","Files(0)"],
  },
  "a phone": {
    rows: [
      { label: "New AI Chat", shortcut: "Ctrl+L" },
      { label: "PPM Assistant" },
      { label: "New File", shortcut: "Ctrl+N" },
      { label: "New DB Query" },
      { label: "New Terminal" },
      { label: "Remote Access" },
      { label: "Forward a Port" },
      { label: "PPM Cloud & Share" },
      { label: "New connection…" },
      { label: "Voice Input", shortcut: "Ctrl+Shift+V" },
      { label: "Git Status", shortcut: "Ctrl+Shift+E" },
      { label: "Problems", shortcut: "Ctrl+Shift+M" },
      { label: "Toggle Word Wrap" },
      { label: "Compare Files...", shortcut: "Ctrl+Alt+D" },
      { label: "Turn Off Language Server", hint: "This device" },
      { label: "Settings", shortcut: "Ctrl+," },
      { label: "Open File Explorer" },
      { label: "System Monitor" },
      { label: "Logs" },
      { label: "Report a Bug" },
      { label: "New Design…" },
      { label: "Designs" },
      { label: "Open Design: Landing page", hint: "designs/landing" },
      { label: "View Git Graph", hint: "Git Graph", shortcut: "Ctrl+Shift+G" },
      { label: "Add Note" },
    ],
    chips: ["Actions(25)","Files(0)"],
  },
  "a touch-only tablet": {
    rows: [
      { label: "New AI Chat", shortcut: "Ctrl+L" },
      { label: "PPM Assistant" },
      { label: "New File", shortcut: "Ctrl+N" },
      { label: "New DB Query" },
      { label: "New Terminal" },
      { label: "Remote Access" },
      { label: "Forward a Port" },
      { label: "PPM Cloud & Share" },
      { label: "New connection…" },
      { label: "Voice Input", shortcut: "Ctrl+Shift+V" },
      { label: "Git Status", shortcut: "Ctrl+Shift+E" },
      { label: "Problems", shortcut: "Ctrl+Shift+M" },
      { label: "Toggle Word Wrap", shortcut: "Alt+Z" },
      { label: "Compare Files...", shortcut: "Ctrl+Alt+D" },
      { label: "Settings", shortcut: "Ctrl+," },
      { label: "Open File Explorer" },
      { label: "System Monitor" },
      { label: "Logs" },
      { label: "Report a Bug" },
      { label: "New Design…" },
      { label: "Designs" },
      { label: "Open Design: Landing page", hint: "designs/landing" },
      { label: "Add column", hint: "Table editor" },
      { label: "Add index", hint: "Table editor" },
      { label: "New table" },
      { label: "Export database" },
      { label: "Import data" },
      { label: "View Git Graph", hint: "Git Graph", shortcut: "Ctrl+Shift+G" },
      { label: "Add Note" },
    ],
    chips: ["Actions(29)","Files(0)"],
  },
};
