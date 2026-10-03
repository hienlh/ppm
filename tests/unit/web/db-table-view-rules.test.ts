/**
 * The table tab's rules that need no grid: what its metadata keeps of the view (hidden columns, the
 * panel's width, dragged column widths) and what it drops coming back from storage; DBGate's keys
 * and where each one acts; which toolbar buttons are there; the Refresh menu; the Columns list's
 * search and the phone's labels.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { installDom, uninstallDom } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const {
  DEFAULT_TABLE_VIEW, PANEL_WIDTH, TAB_VIEW_FIELD, clampPanelWidth, readTabView, withTabView,
} = await import("../../../src/web/components/database/grid/table-view-state");
const { CELL_EDITOR_SELECTOR, asElement, isGridKeyCommand, isTextField, tableKeyCommand, tableKeyPlace } = await import("../../../src/web/components/database/grid/table-keys");
const { FORM_NAVIGATION, countBadge, formStepDisabled, saveButtonState, tableButtons } = await import("../../../src/web/components/database/grid/table-toolbar");
const { AUTO_REFRESH_EVERY, refreshLabel, refreshMenuItems } = await import("../../../src/web/components/database/grid/refresh-menu");
const { columnsMatching } = await import("../../../src/web/components/database/grid/columns-panel");
const { columnsShownLabel } = await import("../../../src/web/components/database/grid/columns-sheet");
const { sortChipText } = await import("../../../src/web/components/database/grid/filter-chips");
const { formatCombo, parseCombo } = await import("../../../src/web/stores/keybindings-store");

type KeyPlace = Parameters<typeof tableKeyCommand>[1];

describe("the view a table tab keeps", () => {
  it("reads nothing kept as the default view", () => {
    expect(readTabView(undefined)).toEqual(DEFAULT_TABLE_VIEW);
    expect(readTabView({})).toEqual(DEFAULT_TABLE_VIEW);
    for (const junk of [null, 7, "x", [], [1]]) expect(readTabView({ [TAB_VIEW_FIELD]: junk })).toEqual(DEFAULT_TABLE_VIEW);
  });

  it("keeps hidden columns once each, and only names", () => {
    const view = readTabView({ [TAB_VIEW_FIELD]: { hidden: ["a", "b", "a", "", 7, null, "x".repeat(1_001), "c"] } });
    expect(view.hidden).toEqual(["a", "b", "c"]);
    expect(readTabView({ [TAB_VIEW_FIELD]: { hidden: "a" } }).hidden).toEqual([]);
  });

  it("reads at most a thousand hidden columns and a thousand widths from a damaged tab", () => {
    const names = Array.from({ length: 1_500 }, (_, i) => `c${i}`);
    const view = readTabView({ [TAB_VIEW_FIELD]: { hidden: names, columnWidths: Object.fromEntries(names.map((n) => [n, 120])) } });
    expect(view.hidden).toHaveLength(1_000);
    expect(view.hidden.at(-1)).toBe("c999");
    expect(Object.keys(view.columnWidths)).toHaveLength(1_000);
  });

  it("keeps the panel between 170 and 420px", () => {
    expect(PANEL_WIDTH).toEqual({ min: 170, max: 420, initial: 300 });
    expect(clampPanelWidth(50)).toBe(170);
    expect(clampPanelWidth(9_999)).toBe(420);
    expect(clampPanelWidth(233.6)).toBe(234);
    expect(clampPanelWidth(170)).toBe(170);
    expect(clampPanelWidth(420)).toBe(420);
    expect(clampPanelWidth(Number.NaN)).toBe(300);
    expect(clampPanelWidth(Number.POSITIVE_INFINITY)).toBe(300);
    expect(readTabView({ [TAB_VIEW_FIELD]: { panelWidth: 10 } }).panelWidth).toBe(170);
    expect(readTabView({ [TAB_VIEW_FIELD]: { panelWidth: "250" } }).panelWidth).toBe(300);
  });

  it("keeps each dragged width between 40 and 2000px, rounded, and nothing else", () => {
    const view = readTabView({
      [TAB_VIEW_FIELD]: { columnWidths: { a: 120.4, b: 39, c: 40, d: 2_000, e: 2_001, f: "90", g: Number.NaN, "": 80 } },
    });
    expect(view.columnWidths).toEqual({ a: 120, c: 40, d: 2_000 });
    expect(readTabView({ [TAB_VIEW_FIELD]: { columnWidths: [100] } }).columnWidths).toEqual({});
  });

  it("keeps a column called __proto__ as a column", () => {
    const kept = JSON.parse('{"gridView":{"columnWidths":{"__proto__":150,"id":80}}}') as Record<string, unknown>;
    const widths = readTabView(kept).columnWidths;
    expect(Object.hasOwn(widths, "__proto__")).toBe(true);
    expect(widths["__proto__"]).toBe(150);
    expect(Object.getPrototypeOf(widths)).toBe(Object.prototype);
    expect(Object.keys(widths)).toEqual(["__proto__", "id"]);
  });

  it("writes only what differs from the default, and leaves the rest of the metadata alone", () => {
    const metadata = { tableName: "orders", filters: { columns: {} } };
    expect(withTabView(metadata, DEFAULT_TABLE_VIEW)).toEqual(metadata);
    expect(withTabView({ ...metadata, [TAB_VIEW_FIELD]: { hidden: ["a"] } }, DEFAULT_TABLE_VIEW)).toEqual(metadata);
    expect(withTabView(metadata, { ...DEFAULT_TABLE_VIEW, hidden: ["qty"] })).toEqual({ ...metadata, [TAB_VIEW_FIELD]: { hidden: ["qty"] } });
    expect(withTabView(metadata, { ...DEFAULT_TABLE_VIEW, panelWidth: 240 })).toEqual({ ...metadata, [TAB_VIEW_FIELD]: { panelWidth: 240 } });
    expect(withTabView(undefined, { ...DEFAULT_TABLE_VIEW, columnWidths: { id: 90 } })).toEqual({ [TAB_VIEW_FIELD]: { columnWidths: { id: 90 } } });
  });

  it("reads back the view it wrote", () => {
    const view = { hidden: ["status", "note"], panelWidth: 222, columnWidths: { id: 64, status: 180 }, form: true };
    expect(readTabView(withTabView({ tableName: "orders" }, view))).toEqual(view);
  });

  it("keeps the form view only when it is on, and only as true", () => {
    const metadata = { tableName: "orders" };
    expect(withTabView(metadata, { ...DEFAULT_TABLE_VIEW, form: true })).toEqual({ ...metadata, [TAB_VIEW_FIELD]: { form: true } });
    expect(withTabView(metadata, { ...DEFAULT_TABLE_VIEW, form: false })).toEqual(metadata);
    expect(readTabView({ [TAB_VIEW_FIELD]: { form: true } }).form).toBe(true);
    for (const junk of ["true", 1, null, {}]) expect(readTabView({ [TAB_VIEW_FIELD]: { form: junk } }).form).toBe(false);
  });
});

/** A keydown as the browser sends it; `Mod` is Ctrl, or ⌘ on a Mac, as the app reads it. */
function key(combo: string, extra: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  const parsed = parseCombo(combo);
  const name = combo.split("+").at(-1)!;
  return new KeyboardEvent("keydown", {
    key: name.length === 1 ? name.toLowerCase() : name,
    ctrlKey: parsed.ctrl, metaKey: parsed.meta, altKey: parsed.alt, shiftKey: parsed.shift, ...extra,
  });
}

describe("DBGate's keys on a table", () => {
  const BINDINGS = [
    ["F5", "refresh"],
    ["Mod+R", "refresh"],
    ["Mod+F5", "refresh-structure"],
    ["Mod+Shift+R", "toggle-auto-refresh"],
    ["Mod+S", "save"],
    ["Insert", "new-row"],
    ["Mod+Delete", "delete-rows"],
    ["Mod+Z", "undo"],
    ["Mod+Y", "redo"],
    ["Mod+U", "revert-rows"],
    ["Mod+L", "toggle-panel"],
    ["Mod+Shift+E", "clear-filters"],
    ["F4", "toggle-form"],
    ["Mod+E", "export-advanced"],
    ["Mod+Shift+C", "clone-rows"],
    ["Mod+0", "set-null"],
    ["Mod+F", "find-column"],
    ["Mod+H", "hide-columns"],
    ["Mod+Shift+F", "filter-selected"],
    ["Mod+J", "edit-row-json"],
    ["Mod+G", "generate-sql"],
  ] as const;
  const GRID_KEYS = ["Mod+Shift+C", "Mod+0", "Mod+F", "Mod+H", "Mod+Shift+F", "Mod+J", "Mod+G"];
  const none = (combos: string[]) => Object.fromEntries(combos.map((combo) => [combo, null]));

  it("maps each of DBGate's keys to its command on the grid or a button", () => {
    for (const [combo, command] of BINDINGS) expect([combo, tableKeyCommand(key(combo), "view")]).toEqual([combo, command]);
  });

  it("leaves every other key to whoever else wants it", () => {
    for (const combo of [
      "R", "Delete", "Shift+F5", "Alt+F5", "Mod+Shift+S", "Mod+Alt+E", "E", "Shift+Insert", "Mod+Alt+L", "Mod+F4", "Shift+F4", "Mod+Shift+Z", "Z", "Mod+Alt+U",
      // Copy is the grid's own; the others are near misses of the selection's keys.
      "Mod+C", "Shift+C", "0", "Mod+Shift+0", "Mod+Alt+0", "F", "Shift+F", "Mod+Alt+F", "Mod+Shift+H", "Mod+Shift+J", "Mod+Alt+G",
    ]) {
      expect([combo, tableKeyCommand(key(combo), "view")]).toEqual([combo, null]);
    }
  });

  it("lets a text field keep the keys it types with, and the view's others still work there", () => {
    const inText = Object.fromEntries(BINDINGS.map(([combo]) => [combo, tableKeyCommand(key(combo), "text")]));
    expect(inText).toEqual({
      "F5": "refresh", "Mod+R": "refresh", "Mod+F5": "refresh-structure", "Mod+Shift+R": "toggle-auto-refresh",
      "Mod+S": null, "Insert": null, "Mod+Delete": null, "Mod+Z": null, "Mod+Y": null, "Mod+U": null,
      "Mod+L": "toggle-panel", "Mod+Shift+E": "clear-filters", "F4": "toggle-form", "Mod+E": "export-advanced",
      // A filter box is not the grid: find, history and the rest stay the browser's there.
      ...none(GRID_KEYS),
    });
  });

  it("names the commands only the grid runs, on its selection", () => {
    expect(BINDINGS.filter(([, command]) => isGridKeyCommand(command)).map(([combo]) => combo)).toEqual(GRID_KEYS);
  });

  it("only keeps the browser from reloading under an open cell editor", () => {
    const inEditor = Object.fromEntries(BINDINGS.map(([combo]) => [combo, tableKeyCommand(key(combo), "cell-editor")]));
    expect(inEditor).toEqual({
      "F5": "swallow", "Mod+R": "swallow", "Mod+F5": "swallow", "Mod+Shift+R": "swallow",
      "Mod+S": null, "Insert": null, "Mod+Delete": null, "Mod+Z": null, "Mod+Y": null, "Mod+U": null,
      "Mod+L": null, "Mod+Shift+E": null, "F4": null, "Mod+E": null, ...none(GRID_KEYS),
    });
  });

  it("acts once on a key held down", () => {
    for (const place of ["view", "text"] satisfies KeyPlace[]) {
      expect(tableKeyCommand(key("F5", { repeat: true }), place)).toBe("swallow");
      expect(tableKeyCommand(key("Mod+L", { repeat: true }), place)).toBe("swallow");
      // Held, F4 would flip between the grid and the form on every repeat.
      expect(tableKeyCommand(key("F4", { repeat: true }), place)).toBe("swallow");
      // Held, Ctrl+E would open an Import/Export tab on every repeat.
      expect(tableKeyCommand(key("Mod+E", { repeat: true }), place)).toBe("swallow");
    }
    // A key a text field keeps is its own, held or not.
    expect(tableKeyCommand(key("Insert", { repeat: true }), "text")).toBeNull();
    expect(tableKeyCommand(key("Mod+U", { repeat: true }), "view")).toBe("swallow");
    // Held, Ctrl+Shift+C would clone the rows again on every repeat.
    for (const combo of GRID_KEYS) expect([combo, tableKeyCommand(key(combo, { repeat: true }), "view")]).toEqual([combo, "swallow"]);
  });

  it("goes on undoing and redoing while the key is held, as undo does everywhere", () => {
    expect(tableKeyCommand(key("Mod+Z", { repeat: true }), "view")).toBe("undo");
    expect(tableKeyCommand(key("Mod+Y", { repeat: true }), "view")).toBe("redo");
  });

  it("does nothing while an input method is composing", () => {
    expect(tableKeyCommand(key("F5", { isComposing: true }), "view")).toBeNull();
    expect(tableKeyCommand(key("Mod+S", { isComposing: true }), "view")).toBeNull();
  });

  it("tells a field that takes typing from one that does not", () => {
    const el = (html: string) => {
      const box = document.createElement("div");
      box.innerHTML = html;
      return box.firstElementChild!;
    };
    for (const html of ["<textarea></textarea>", "<select></select>", "<input>", '<input type="number">', '<input type="search">', '<input type="password">', '<div contenteditable="true"></div>']) {
      expect([html, isTextField(el(html))]).toEqual([html, true]);
    }
    for (const html of ['<input type="checkbox">', '<input type="radio">', '<input type="button">', '<input type="range">', '<input type="color">', '<input type="file">', "<button></button>", "<div></div>"]) {
      expect([html, isTextField(el(html))]).toEqual([html, false]);
    }
    expect(isTextField(null)).toBe(false);
  });

  it("says where a key landed, seen from the view", () => {
    document.body.innerHTML = `
      <div id="root"><button id="b">Save</button><input id="f"><div id="grid"></div><input id="form-editor" data-cell-editor=""></div>
      <div id="portal"><div class="gdg-clip-region"><textarea id="editor"></textarea></div></div>
      <div id="dialog"><input id="other"></div>`;
    const root = document.getElementById("root")!;
    const at = (id: string) => tableKeyPlace(root, document.getElementById(id));
    expect(at("b")).toBe("view");
    expect(at("grid")).toBe("view");
    expect(at("f")).toBe("text");
    // Glide renders its editor in #portal, outside the view, and its keys still belong to the grid.
    expect(document.getElementById("editor")!.closest(CELL_EDITOR_SELECTOR)?.classList.contains("gdg-clip-region")).toBe(true);
    expect(at("editor")).toBe("cell-editor");
    // The form view's editor is a text field inside the view, and its keys are an editor's all the same.
    expect(document.getElementById("form-editor")!.matches(CELL_EDITOR_SELECTOR)).toBe(true);
    expect(at("form-editor")).toBe("cell-editor");
    // A dialog the view opened is portalled elsewhere: its keys are the dialog's.
    expect(at("other")).toBeNull();
    expect(tableKeyPlace(root, null)).toBeNull();
    expect(tableKeyPlace(root, document.createTextNode("x"))).toBeNull();
    document.body.innerHTML = "";
  });

  it("takes an element from another window by its shape", () => {
    const foreign = { closest: () => null, tagName: "TEXTAREA" };
    expect(asElement(foreign as unknown as EventTarget)).toBe(foreign as unknown as Element);
    expect(isTextField(foreign as unknown as Element)).toBe(true);
    expect(asElement(window as unknown as EventTarget)).toBeNull();
    expect(asElement(null)).toBeNull();
  });
});

const EDIT = { pending: 0, newRows: 0, selectedRows: 0, selectedColumns: [], canChangeRows: true };

describe("the toolbar's buttons", () => {
  it("greys Save out with nothing to save, and says why on a read-only connection", () => {
    expect(saveButtonState(null, false)).toEqual({ count: 0, disabled: true, title: `Table data: Save (${formatCombo("Mod+S")})` });
    expect(saveButtonState({ ...EDIT, pending: 3 }, false)).toMatchObject({ count: 3, disabled: false });
    expect(saveButtonState({ ...EDIT, pending: 3 }, true)).toEqual({ count: 3, disabled: true, title: "The connection is read-only" });
  });

  it("shows Revert all once something is changed, new rows included", () => {
    const shown = (edit: typeof EDIT | null) => tableButtons({ edit, readonly: false, hasMore: false }).revert;
    expect(shown(null)).toBe(false);
    expect(shown(EDIT)).toBe(false);
    expect(shown({ ...EDIT, pending: 1 })).toBe(true);
    expect(shown({ ...EDIT, newRows: 1 })).toBe(true);
  });

  it("shows New row and Delete row(s) only where rows can be changed, Delete only with rows selected", () => {
    const shown = (edit: typeof EDIT | null, readonly = false) => {
      const b = tableButtons({ edit, readonly, hasMore: false });
      return [b.newRow, b.deleteRows];
    };
    expect(shown(EDIT)).toEqual([true, false]);
    expect(shown({ ...EDIT, selectedRows: 2 })).toEqual([true, true]);
    expect(shown({ ...EDIT, selectedRows: 2 }, true)).toEqual([false, false]);
    expect(shown({ ...EDIT, selectedRows: 2, canChangeRows: false })).toEqual([false, false]);
    expect(shown(null)).toEqual([false, false]);
  });

  it("shows Fetch all while rows remain to read", () => {
    expect(tableButtons({ edit: null, readonly: false, hasMore: true }).fetchAll).toBe(true);
    expect(tableButtons({ edit: EDIT, readonly: true, hasMore: false }).fetchAll).toBe(false);
  });

  it("leaves New row, Delete row(s) and Fetch all to the grid in the form view, as DBGate's form toolbar does", () => {
    const form = (on: boolean) => ({ on, onToggle: () => {}, onNavigate: () => {} });
    const edit = { ...EDIT, pending: 1, selectedRows: 2 };
    expect(tableButtons({ edit, readonly: false, hasMore: true, form: form(false) })).toEqual({ revert: true, newRow: true, deleteRows: true, fetchAll: true });
    expect(tableButtons({ edit, readonly: false, hasMore: true, form: form(true) })).toEqual({ revert: true, newRow: false, deleteRows: false, fetchAll: false });
  });

  it("names the form's steps and their keys as DBGate's toolbar does", () => {
    expect(FORM_NAVIGATION.map((n) => [n.to, n.label, formatCombo(n.combo)])).toEqual([
      ["first", "First", formatCombo("Mod+Home")],
      ["previous", "Previous", formatCombo("Mod+\u2191")],
      ["next", "Next", formatCombo("Mod+\u2193")],
      ["last", "Last", formatCombo("Mod+End")],
    ]);
  });

  it("greys out a step the form cannot take: back from the first row, on from the last", () => {
    const at = (atFirst: boolean, atLast: boolean) => ({ ...EDIT, form: { atFirst, atLast } });
    const steps = (edit: Parameters<typeof formStepDisabled>[0]) => FORM_NAVIGATION.map((n) => formStepDisabled(edit, n.to));
    expect(steps(at(true, false))).toEqual([true, true, false, false]);
    expect(steps(at(false, true))).toEqual([false, false, true, true]);
    expect(steps(at(false, false))).toEqual([false, false, false, false]);
    // One row is both.
    expect(steps(at(true, true))).toEqual([true, true, true, true]);
    // No form, or no rows yet: nothing to step through.
    expect(steps(EDIT)).toEqual([true, true, true, true]);
    expect(steps(null)).toEqual([true, true, true, true]);
  });

  it("counts Save's rows up to 9+", () => {
    expect([1, 9, 10, 250].map(countBadge)).toEqual(["1", "9", "9+", "9+"]);
  });
});

describe("Refresh's menu", () => {
  const auto = (running: boolean, every = 10) => {
    const calls: unknown[] = [];
    return { calls, auto: { running, every, start: (s?: number) => calls.push(["start", s]), stop: () => calls.push(["stop"]) } };
  };

  it("lists DBGate's items, with their keys, in its order", () => {
    const { auto: a } = auto(false);
    expect(refreshMenuItems(() => {}, a).map((i) => [i.label, i.shortcut ?? ""])).toEqual([
      ["Refresh with structure", formatCombo("Mod+F5")],
      ["Start auto refresh", formatCombo("Mod+Shift+R")],
      ["Refresh every 1 second", ""],
      ["...5 seconds", ""], ["...10 seconds", ""], ["...15 seconds", ""], ["...30 seconds", ""], ["...60 seconds", ""],
    ]);
    expect(AUTO_REFRESH_EVERY).toEqual([1, 5, 10, 15, 30, 60]);
  });

  it("starts at the interval picked, and stops when running", () => {
    const off = auto(false);
    let structure = 0;
    const items = refreshMenuItems(() => { structure += 1; }, off.auto);
    for (const item of items) item.onSelect();
    expect(structure).toBe(1);
    expect(off.calls).toEqual([["start", undefined], ["start", 1], ["start", 5], ["start", 10], ["start", 15], ["start", 30], ["start", 60]]);

    const on = auto(true, 5);
    const stop = refreshMenuItems(() => {}, on.auto)[1]!;
    expect(stop.label).toBe("Stop auto refresh");
    stop.onSelect();
    expect(on.calls).toEqual([["stop"]]);
  });

  it("says on the button how often it refreshes", () => {
    expect(refreshLabel(auto(false).auto)).toBe("Refresh");
    expect(refreshLabel(auto(true, 15).auto)).toBe("Refresh (every 15s)");
  });
});

describe("the Columns list and a phone's labels", () => {
  const schema = ["id", "Customer_ID", "status", "created_at"].map((name) => ({
    name, type: "text", nullable: true, pk: false, defaultValue: null, fk: null,
  }));

  it("finds columns by any part of their name, ignoring case, in the table's order", () => {
    expect(columnsMatching(schema, "ID").map((c) => c.name)).toEqual(["id", "Customer_ID"]);
    expect(columnsMatching(schema, "  stat ").map((c) => c.name)).toEqual(["status"]);
    expect(columnsMatching(schema, "zzz")).toEqual([]);
    const all = columnsMatching(schema, " ");
    expect(all.map((c) => c.name)).toEqual(schema.map((c) => c.name));
    // A copy: the panel may not reorder the table's own list.
    expect(all).not.toBe(schema);
  });

  it("names what a phone's sheet and chips show", () => {
    expect(columnsShownLabel("users", 9, 2)).toBe("users · 7 of 9 columns shown");
    expect(columnsShownLabel("users", 3, 0)).toBe("users · 3 of 3 columns shown");
    expect(sortChipText([{ column: "id", dir: "ASC" }, { column: "name", dir: "DESC" }])).toBe("id ↑, name ↓");
  });
});
