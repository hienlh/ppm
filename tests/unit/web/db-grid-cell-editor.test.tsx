/**
 * Enter and Tab in a grid cell's editor put in what was typed, however soon after the last key they
 * come. Glide 6.0.3's editor ends an edit from a timer, one per key, and a key's timer still waiting
 * when Enter arrives closes the editor with nothing saved — so these run Glide's own overlay editor
 * (not exported: imported by its file) with the keys arriving as a fast typist's do, the last
 * letter and then Enter before any timer has run. Each loss is shown with Glide's editor too: once
 * an upgrade keeps the value there, the wrapper is no longer needed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { act } = await import("react");
const { AllCellRenderers, GridCellKind, getDefaultTheme } = await import("@glideapps/glide-data-grid");
const OVERLAY = resolve(import.meta.dir, "../../../node_modules/@glideapps/glide-data-grid/dist/esm/internal/data-grid-overlay-editor/data-grid-overlay-editor.js");
const { default: DataGridOverlayEditor } = (await import(OVERLAY)) as { default: (p: Record<string, unknown>) => React.ReactNode };
const { cellEditor } = await import("../../../src/web/components/database/grid/cell-editor.tsx");
const { fkCellEditor } = await import("../../../src/web/components/database/grid/fk-cell-editor.tsx");
type GridCell = import("@glideapps/glide-data-grid").GridCell;
type Provide = (cell: GridCell) => unknown;

const TEXT: GridCell = { kind: GridCellKind.Text, data: "Bo", displayData: "Bo", allowOverlay: true };
/** Glide's own editor for every cell: what the grid had before the wrapper. */
const GLIDE: Provide = () => undefined;
const OURS: Provide = (cell) => cellEditor(cell);

beforeAll(() => {
  const portal = document.createElement("div");
  portal.id = "portal";
  document.body.appendChild(portal);
});
let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

/**
 * The editor open on a cell, as the grid opens it: by F2 — the value as it is, selected — or by
 * typing a key, which replaces the value with that key. What it finished with is recorded.
 */
async function open(provide: Provide, opened: "F2" | { typed: string } = "F2", content: GridCell = TEXT) {
  const finished: [unknown, unknown][] = [];
  const typed = typeof opened === "object";
  const shown = typed && content.kind === GridCellKind.Text ? { ...content, data: opened.typed } : content;
  view = await mount(
    <DataGridOverlayEditor
      target={{ x: 0, y: 0, width: 160, height: 34 }} content={shown} cell={[1, 0]} id="overlay" theme={getDefaultTheme()}
      forceEditMode={typed} initialValue={typed ? opened.typed : undefined} highlight={!typed}
      getCellRenderer={(c: GridCell) => AllCellRenderers.find((r) => r.kind === c.kind)} provideEditor={provide}
      onFinishEditing={(value: GridCell | undefined, movement: unknown) => finished.push([value && "data" in value ? value.data : value, movement])}
    />,
  );
  return finished;
}
// A text cell edits in a textarea, a number cell in an input.
const input = () => document.querySelector<HTMLTextAreaElement>("#portal textarea, #portal input")!;
const keydown = (key: string, init: KeyboardEventInit = {}) =>
  input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
/**
 * The last letter of `text` typed, then `key`, in one go: both keys are in before either key's
 * timer runs. `act` draws what was typed in between, as the browser does before the next key.
 */
function typeThen(text: string, key: string, init: KeyboardEventInit = {}) {
  act(() => {
    keydown(text.at(-1)!);
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => { keydown(key, init); });
}
/** Glide's timers, run. */
const timers = () => act(async () => { await Bun.sleep(5); });

describe("Enter and Tab right after the last key", () => {
  it("put in what was typed and move down or along, where Glide's editor loses it", async () => {
    for (const [key, init, move] of [["Enter", {}, [0, 1]], ["Tab", {}, [1, 0]], ["Tab", { shiftKey: true }, [-1, 0]]] as const) {
      const ours = await open(OURS);
      typeThen("Bob", key, init);
      // Ended on the key itself, before any timer.
      expect(ours).toEqual([["Bob", move]]);
      await timers();
      expect(ours).toEqual([["Bob", move]]);
      await view!.unmount();

      const glide = await open(GLIDE);
      typeThen("Bob", key, init);
      await timers();
      expect(glide).toEqual([[undefined, move]]);
      await view!.unmount();
      view = null;
    }
  });

  it("put in the ⋯ editor's value too, on a foreign key", async () => {
    const finished = await open((cell) => fkCellEditor(cell, "customers", () => {}));
    typeThen("Bob", "Enter");
    await timers();
    expect(finished).toEqual([["Bob", [0, 1]]]);
  });

  it("put in a number typed into a number cell", async () => {
    const NUMBER: GridCell = { kind: GridCellKind.Number, data: 4, displayData: "4", allowOverlay: true };
    for (const [provide, after] of [[OURS, [[45, [0, 1]]]], [GLIDE, [[undefined, [0, 1]]]]] as const) {
      const finished = await open(provide, { typed: "4" }, NUMBER);
      // Glide loads its number editor lazily.
      for (let i = 0; i < 100 && !input(); i++) await act(async () => { await Bun.sleep(10); });
      act(() => {
        keydown("5");
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input(), "45");
        input().dispatchEvent(new Event("input", { bubbles: true }));
      });
      act(() => { keydown("Enter"); });
      await timers();
      expect(finished).toEqual(after as never);
      await view!.unmount();
      view = null;
    }
  });
});

describe("what Glide's own editor would have saved", () => {
  it("saves the key the editor was opened by, when Enter follows it at once", async () => {
    const finished = await open(OURS, { typed: "z" });
    act(() => { keydown("Enter"); });
    expect(finished).toEqual([["z", [0, 1]]]);
  });

  it("saves nothing when the editor was opened by F2 and left as it was, and still moves down", async () => {
    const finished = await open(OURS);
    act(() => { keydown("Enter"); });
    expect(finished).toEqual([[undefined, [0, 1]]]);
  });

  it("leaves a new line, Escape and an input method's Enter to Glide", async () => {
    for (const [key, init, after] of [
      // A new line in the text: the edit goes on.
      ["Enter", { shiftKey: true }, []],
      ["Escape", {}, [[undefined, [0, 0]]]],
      // Glide's editor saves on it, later, as it would have.
      ["Enter", { isComposing: true }, [["Bob", [0, 1]]]],
    ] as const) {
      const finished = await open(OURS);
      act(() => {
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(input(), "Bob");
        input().dispatchEvent(new Event("input", { bubbles: true }));
      });
      act(() => { keydown(key, init); });
      expect(finished).toEqual([]);
      await timers();
      expect(finished).toEqual(after as never);
      await view!.unmount();
      view = null;
    }
  });
});
