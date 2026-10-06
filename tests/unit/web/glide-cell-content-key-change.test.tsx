/**
 * `getCellContent` is created once — the canvas calls it on every frame — so
 * everything it reads has to come through a ref. The key column did not: it
 * was the value of the first render, and a grid whose first render had no key
 * (a cached page from before row keys, or the previous table of the same tab)
 * kept looking pending edits up under that key forever. The edits were saved
 * but never shown, and a new row did not render as one.
 */
import { describe, it, expect, afterAll, afterEach } from "bun:test";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { act, useState } = await import("react");
const { useGlideCellContent } = await import("../../../src/web/components/database/use-glide-cell-content.ts");
const { EMPTY_CHANGESET, addRows, editCells } = await import("../../../src/web/components/database/grid/grid-changeset.ts");
type GridChangeColors = import("../../../src/web/components/database/glide-grid-theme.ts").GridChangeColors;

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

const schema = [
  { name: "id", type: "text", nullable: false, pk: true },
  { name: "name", type: "text", nullable: true, pk: false },
];

describe("getCellContent after the key column changes", () => {
  it("shows a pending edit under the key the grid has now, not the one it started with", async () => {
    const rows = [{ id: "a", name: "before" }, { id: "__new_1", name: null }];
    const changesetRef = { current: editCells(addRows(EMPTY_CHANGESET, [{ id: "__new_1" }]), [{ row: rows[0]!, column: "name", value: "edited" }], "id", ["id"]) };
    const colors = { edited: "rgb(1, 2, 3)" } as GridChangeColors;
    const ref = {} as { hook: ReturnType<typeof useGlideCellContent>; setPk: (pk: string | null) => void };
    function Harness() {
      const [pk, setPk] = useState<string | null>(null);
      ref.setPk = setPk;
      ref.hook = useGlideCellContent(rows, ["id", "name"], schema, pk, () => {}, changesetRef, colors);
      return null;
    }
    view = await mount(<Harness />);
    const first = ref.hook.getCellContent;
    await act(async () => { ref.setPk("id"); });

    // Still the same callback, which is the point: the canvas never gets a new one.
    expect(ref.hook.getCellContent).toBe(first);
    expect(ref.hook.getCellContent([1, 0])).toMatchObject({ displayData: "edited", themeOverride: { bgCell: "rgb(1, 2, 3)" } });
    // A new row's key cell is where its id is typed: DBGate's (No Field), never the grid's name for the row.
    expect(ref.hook.getCellContent([0, 1])).toMatchObject({ displayData: "(No Field)", allowOverlay: true, readonly: false });
  });
});
