/**
 * Saving a Query tab's SQL to a file, against a stubbed file system: the first save asks for a name
 * and a folder and adds `.sql`, a file already there is replaced only once the user says so, a tab
 * with a file writes it again with no question, the SQL written is the SQL as it is when written,
 * and a write that fails says why and leaves the tab as it was. Ctrl+S saves only the tab in front,
 * once per press, and never from a dialog over it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { click, installDom, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
// Radix's dialogs watch their content for focus.
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);
const { act } = await import("react");
const { toast } = await import("sonner");
const { useQueryFileSave } = await import("../../../src/web/components/database/query/use-query-file-save");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const { formatCombo } = await import("../../../src/web/stores/keybindings-store");

// Save As starts in the open project's folder; these tests start with none, so in the home folder.
// The store is the process's: whatever project a file before this one left open goes back after.
// So are the panels, which the Ctrl+S tests rearrange.
const projectBefore = useProjectStore.getState().activeProject;
const { focusedPanelId: focusedBefore, panels: panelsBefore } = usePanelStore.getState();
afterAll(() => {
  useProjectStore.setState({ activeProject: projectBefore });
  usePanelStore.setState({ focusedPanelId: focusedBefore, panels: panelsBefore });
});

const TAB = "db-query:q";
/** Puts `activeTabId` in front, as far as Ctrl+S can tell. */
const inFront = (activeTabId: string) =>
  usePanelStore.setState({ focusedPanelId: "main", panels: { main: { id: "main", activeTabId, tabHistory: [], tabs: [] } } } as never);

const HOME = "/home/u";
const FOLDER = "/home/u/sql";
const dirEntry = (name: string, path: string) => ({ name, path, type: "directory", kind: "folder", modified: "2026-10-03T09:00:00Z" });
const fileEntry = (name: string, dir: string) => ({ name, path: `${dir}/${name}`, type: "file", kind: "sql", size: 12, modified: "2026-10-03T09:00:00Z" });

/** What each folder holds, by its path; a folder missing here cannot be read. */
let folders: Record<string, unknown[]> = {};
let writes: { path: string; content: string }[] = [];
/** Why a write fails, when it should. */
let writeFails: string | null = null;

beforeEach(() => {
  inFront(TAB);
  useProjectStore.setState({ activeProject: null });
  folders = { [HOME]: [dirEntry("sql", FOLDER)], [FOLDER]: [] };
  writes = [];
  writeFails = null;
  installGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/api/fs/browse") {
      const asked = url.searchParams.get("path");
      const path = asked === "~" ? HOME : asked ?? HOME;
      const entries = folders[path];
      if (!entries) return json({ ok: false, error: `Cannot read ${path}` }, 403);
      return json({ ok: true, data: { entries, current: path, parent: "/home", breadcrumbs: [], sep: "/" } });
    }
    if (url.pathname === "/api/fs/write" && init?.method === "PUT") {
      if (writeFails) return json({ ok: false, error: writeFails }, 500);
      writes.push(JSON.parse(String(init.body)));
      return json({ ok: true, data: {} });
    }
    return json({ ok: true, data: {} });
  }) as typeof fetch);
});

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

let sqlNow = "";
let saved: { path: string; sql: string }[] = [];
function Host({ savedPath, keys }: { savedPath: string | null; keys: boolean }) {
  const { save, dialogs } = useQueryFileSave({
    tabId: TAB, keys, title: "Query 3", savedPath, sql: () => sqlNow, onSaved: (path, sql) => { saved.push({ path, sql }); },
  });
  return <><button type="button" onClick={save}>Save</button>{dialogs}</>;
}
async function show(savedPath: string | null = null, keys = true) {
  sqlNow = "SELECT * FROM orders";
  saved = [];
  view = await mount(<Host savedPath={savedPath} keys={keys} />);
}

/** Lets the stubbed fetch answer and React draw what it said. */
const settle = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); });
const buttonNamed = (name: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) ?? null;
const dialogTitled = (title: string) =>
  [...document.body.querySelectorAll('[role="dialog"], [role="alertdialog"]')].find((d) => d.textContent?.includes(title)) ?? null;
async function typeName(name: string) {
  const input = dialogTitled("Save As")!.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
/** The `sql` folder's row in the folder picker. */
const sqlFolderRow = () =>
  [...document.body.querySelectorAll("button")].find((b) => [...b.querySelectorAll("span")].some((s) => s.textContent === "sql")) ?? null;
/** Goes from the name to the folder picker, picks `sql` in the home folder, and lets the write happen. */
async function pickTheSqlFolder() {
  await click(buttonNamed("Choose Folder..."));
  await settle();
  await click(sqlFolderRow());
  await click(buttonNamed("Select"));
  await settle();
}

describe("the first save", () => {
  it("asks for a name, offering the tab's, then a folder, and writes the SQL there", async () => {
    await show();
    await click(buttonNamed("Save"));
    const asked = dialogTitled("Save As");
    expect(asked).not.toBeNull();
    expect(asked!.querySelector("input")!.value).toBe("query-3.sql");
    await pickTheSqlFolder();
    expect(writes).toEqual([{ path: `${FOLDER}/query-3.sql`, content: "SELECT * FROM orders" }]);
    expect(saved).toEqual([{ path: `${FOLDER}/query-3.sql`, sql: "SELECT * FROM orders" }]);
    expect(dialogTitled("Save As")).toBeNull();
  });

  it("adds .sql to a name typed without an extension", async () => {
    await show();
    await click(buttonNamed("Save"));
    await typeName("weekly report");
    await pickTheSqlFolder();
    expect(writes.map((w) => w.path)).toEqual([`${FOLDER}/weekly report.sql`]);
  });

  it("writes the SQL as it is when the file is written, not as it was when Save was pressed", async () => {
    await show();
    await click(buttonNamed("Save"));
    sqlNow = "SELECT * FROM orders WHERE total > 100";
    await pickTheSqlFolder();
    expect(writes[0]!.content).toBe("SELECT * FROM orders WHERE total > 100");
    expect(saved[0]!.sql).toBe("SELECT * FROM orders WHERE total > 100");
  });

  it("asks before replacing a file already in the folder, whatever its name's case", async () => {
    folders[FOLDER] = [fileEntry("Query-3.SQL", FOLDER)];
    await show();
    await click(buttonNamed("Save"));
    await pickTheSqlFolder();
    expect(writes).toEqual([]);
    const replace = dialogTitled("Replace file?");
    expect(replace).not.toBeNull();
    expect(replace!.getAttribute("role")).toBe("alertdialog");
    expect(replace!.textContent).toContain("query-3.sql is already in that folder.");
    // Cancel is where the keyboard starts, and leaves the file alone.
    expect(document.activeElement?.textContent).toBe("Cancel");
    await click(buttonNamed("Cancel"));
    await settle();
    expect(dialogTitled("Replace file?")).toBeNull();
    expect(writes).toEqual([]);
    expect(saved).toEqual([]);

    await click(buttonNamed("Save"));
    await pickTheSqlFolder();
    await click(buttonNamed("Replace"));
    await settle();
    expect(writes).toEqual([{ path: `${FOLDER}/query-3.sql`, content: "SELECT * FROM orders" }]);
    expect(saved).toHaveLength(1);
  });

  it("writes when the folder cannot be listed to check: the write says whether it can", async () => {
    await show();
    await click(buttonNamed("Save"));
    await click(buttonNamed("Choose Folder..."));
    await settle();
    delete folders[FOLDER];
    await click(sqlFolderRow());
    await click(buttonNamed("Select"));
    await settle();
    expect(writes.map((w) => w.path)).toEqual([`${FOLDER}/query-3.sql`]);
  });

  it("writes nothing when the name is put away", async () => {
    await show();
    await click(buttonNamed("Save"));
    await click(buttonNamed("Cancel"));
    await settle();
    expect(dialogTitled("Save As")).toBeNull();
    expect(writes).toEqual([]);
    expect(saved).toEqual([]);
  });
});

describe("a tab saved before", () => {
  it("writes its file again with no question", async () => {
    await show(`${FOLDER}/report.sql`);
    sqlNow = "SELECT 2";
    await click(buttonNamed("Save"));
    await settle();
    expect(dialogTitled("Save As")).toBeNull();
    expect(writes).toEqual([{ path: `${FOLDER}/report.sql`, content: "SELECT 2" }]);
    expect(saved).toEqual([{ path: `${FOLDER}/report.sql`, sql: "SELECT 2" }]);
  });

  it("says why a write failed, and leaves the tab unsaved", async () => {
    const shown = spyOn(toast, "error").mockImplementation(() => 0);
    try {
      writeFails = "EACCES: permission denied";
      await show(`${FOLDER}/report.sql`);
      await click(buttonNamed("Save"));
      await settle();
      expect(shown).toHaveBeenCalledWith("Could not save report.sql: EACCES: permission denied");
      expect(saved).toEqual([]);
    } finally {
      shown.mockRestore();
    }
  });
});

describe("Ctrl+S", () => {
  const mac = formatCombo("Mod+S").includes("\u2318");
  /** Presses Ctrl+S (Cmd+S on a Mac) on `from`, and says whether anything took it from the browser. */
  async function press(from: EventTarget = window, init: KeyboardEventInit = {}) {
    const e = new KeyboardEvent("keydown", { key: "s", ctrlKey: !mac, metaKey: mac, bubbles: true, cancelable: true, ...init });
    await act(async () => { from.dispatchEvent(e); });
    await settle();
    return e.defaultPrevented;
  }

  it("saves the tab in front, and keeps the browser's own Save from opening", async () => {
    await show(`${FOLDER}/report.sql`);
    expect(await press()).toBe(true);
    expect(writes).toEqual([{ path: `${FOLDER}/report.sql`, content: "SELECT * FROM orders" }]);
  });

  it("opens Save As for a tab with no file yet", async () => {
    await show();
    await press();
    expect(dialogTitled("Save As")).not.toBeNull();
    expect(writes).toEqual([]);
  });

  it("is not this tab's while another tab is in front", async () => {
    await show(`${FOLDER}/report.sql`);
    inFront("db-query:other");
    expect(await press()).toBe(false);
    expect(writes).toEqual([]);
  });

  it("saves once for a key held down", async () => {
    await show(`${FOLDER}/report.sql`);
    await press();
    await press(window, { repeat: true });
    await press(window, { repeat: true });
    expect(writes).toHaveLength(1);
  });

  it("is a dialog's, when pressed in one over the tab", async () => {
    await show(`${FOLDER}/report.sql`);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "alertdialog");
    const field = dialog.appendChild(document.createElement("input"));
    document.body.appendChild(dialog);
    try {
      expect(await press(field)).toBe(false);
      expect(writes).toEqual([]);
    } finally {
      dialog.remove();
    }
  });

  it("is only Ctrl+S, and there is none on a phone", async () => {
    await show(`${FOLDER}/report.sql`);
    await press(window, { shiftKey: true });
    await press(window, { key: "d" });
    expect(writes).toEqual([]);
    await view!.unmount();
    await show(`${FOLDER}/report.sql`, false);
    expect(await press()).toBe(false);
    expect(writes).toEqual([]);
  });
});
