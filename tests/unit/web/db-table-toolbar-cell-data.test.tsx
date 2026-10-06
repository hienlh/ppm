/**
 * DBGate's Cell Data on a table's toolbar: a toggle after View columns, pressed while the view is
 * open, gone in the form view — and on a phone, Show cell data in the ⋯ menu after Switch to form.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { click, installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { TableActionsMenu, TableToolbar } = await import("../../../src/web/components/database/grid/table-toolbar.tsx");
type TableActions = import("../../../src/web/components/database/grid/table-toolbar.tsx").TableActions;
type GridEditState = import("../../../src/web/components/database/glide-grid-types.ts").GridEditState;

const EDIT: GridEditState = {
  pending: 0, newRows: 0, selectedRows: 0, selectedColumns: [], canChangeRows: true, canUndo: false, canRedo: false, cellData: false,
};
let toggled = 0;
const actions = (over: Partial<TableActions> = {}): TableActions => ({
  table: "users", canOpenTabs: true, onOpenStructure() {}, onOpenSql() {}, onRefresh() {}, onRefreshWithStructure() {},
  auto: { running: false, every: 10, start() {}, stop() {} }, busy: false, idle: false, edit: EDIT, readonly: false,
  onSave() {}, onRevert() {}, onNewRow() {}, onDeleteRows() {}, onUndo() {}, onRedo() {},
  hasMore: false, onFetchAll() {},
  panel: { open: true, onToggle() {} },
  form: { on: false, onToggle() {}, onNavigate() {} },
  cellData: { open: false, onToggle: () => { toggled += 1; } },
  ...over,
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  toggled = 0;
});

describe("the desktop toolbar", () => {
  const cellData = () => document.querySelector<HTMLButtonElement>('[role="toolbar"] button[aria-label="Cell Data"]');
  const labels = () => [...document.querySelectorAll('[role="toolbar"] button')].map((b) => b.getAttribute("aria-label") ?? b.textContent);

  it("toggles the view from after View columns, pressed while it is open", async () => {
    view = await mount(<TableToolbar actions={actions()} />);
    expect(labels().slice(-2)).toEqual(["View columns", "Cell Data"]);
    expect(cellData()!.getAttribute("aria-pressed")).toBe("false");
    expect(cellData()!.title).toBe("Data grid: Toggle cell data view");
    await click(cellData());
    expect(toggled).toBe(1);
    await view.unmount();
    view = await mount(<TableToolbar actions={actions({ cellData: { open: true, onToggle() {} } })} />);
    expect(cellData()!.getAttribute("aria-pressed")).toBe("true");
  });

  it("has none in the form view, nor before there are rows", async () => {
    view = await mount(<TableToolbar actions={actions({ form: { on: true, onToggle() {}, onNavigate() {} } })} />);
    expect(cellData()).toBeNull();
    await view.unmount();
    view = await mount(<TableToolbar actions={actions({ cellData: undefined })} />);
    expect(cellData()).toBeNull();
  });
});

describe("a phone's ⋯ menu", () => {
  const items = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  const item = (label: string) => items().find((b) => b.textContent === label);

  it("shows the cell data after Switch to form, once the grid has rows", async () => {
    view = await mount(<TableActionsMenu actions={actions()} />);
    await click(document.querySelector('button[aria-label="Table actions"]'));
    const names = items().map((b) => b.textContent);
    expect(names.indexOf("Show cell data")).toBe(names.indexOf("Switch to form") + 1);
    await click(item("Show cell data")!);
    expect(toggled).toBe(1);
    await view.unmount();
    view = await mount(<TableActionsMenu actions={actions({ edit: null })} />);
    await click(document.querySelector('button[aria-label="Table actions"]'));
    expect(item("Show cell data")!.disabled).toBe(true);
  });
});
