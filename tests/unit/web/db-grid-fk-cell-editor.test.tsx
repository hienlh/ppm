/**
 * DBGate's ⋯ in a foreign key cell's editor: the cell's own editor with a button beside it, which
 * closes the editor without what was typed and opens the lookup of the table the key refers to.
 * The button must not take focus on its way: Glide reads a click away from its editor as the end
 * of the edit, with whatever was typed in it.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { click, installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { GridCellKind, isObjectEditorCallbackResult } = await import("@glideapps/glide-data-grid");
const { fkCellEditor } = await import("../../../src/web/components/database/grid/fk-cell-editor.tsx");
type GridCell = import("@glideapps/glide-data-grid").GridCell;

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

const text: GridCell = { kind: GridCellKind.Text, data: "7", displayData: "7", allowOverlay: true };
const byLabel = (label: string) => [...document.body.querySelectorAll<HTMLElement>("[aria-label]")].find((e) => e.getAttribute("aria-label") === label) ?? null;

describe("⋯ in a foreign key cell's editor", () => {
  it("sits beside the cell's own editor, and ends the edit without its value before opening the lookup", async () => {
    const calls: string[] = [];
    const result = fkCellEditor(text, "customers", () => calls.push("lookup"));
    if (!result || !isObjectEditorCallbackResult(result)) throw new Error("no editor");
    const Editor = result.editor;
    view = await mount(
      <Editor value={text} onChange={() => {}} isHighlighted={false} forceEditMode={false}
        target={{ x: 0, y: 0, width: 120, height: 30 }} theme={{} as never}
        onFinishedEditing={(value, movement) => calls.push(`finish ${String(value)} ${JSON.stringify(movement)}`)} />,
    );
    // The text cell's own editor, as typed in.
    expect(document.body.querySelector("textarea")?.value).toBe("7");
    const button = byLabel("Look the value up in customers")!;
    expect(button.getAttribute("title")).toBe("Lookup from customers");
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    button.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    await click(button);
    expect(calls).toEqual(["finish undefined [0,0]", "lookup"]);
  });

  it("keeps the options the cell's own editor came with", () => {
    const wrapping = fkCellEditor({ ...text, allowWrapping: true } as GridCell, "customers", () => {});
    expect(wrapping && isObjectEditorCallbackResult(wrapping) && wrapping.disablePadding).toBe(true);
  });

  it("wraps a number cell's editor too, and leaves a cell no text or number editor serves", () => {
    expect(fkCellEditor({ kind: GridCellKind.Number, data: 7, displayData: "7", allowOverlay: true }, "customers", () => {})).toBeDefined();
    expect(fkCellEditor({ kind: GridCellKind.Boolean, data: true, allowOverlay: false }, "customers", () => {})).toBeUndefined();
  });
});
