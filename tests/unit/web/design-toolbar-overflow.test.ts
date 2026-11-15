/**
 * The design toolbar in a narrow pane (a design in a floating window, a split): every bar button
 * used to stay in the row, squeezed to its 16px icon and then pushed past the pane's edge, so the
 * last ones — the Chat toggle among them — could not be reached. Buttons that do not fit now move
 * into More; the pane controls (Chat, Layout) stay in the bar.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { installDom, uninstallDom } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { DESIGN_TOOLBAR_ITEMS, splitBarItems } = await import("../../../src/web/components/design/design-toolbar");

const bar = DESIGN_TOOLBAR_ITEMS.filter((i) => i.placement === "bar");
const more = DESIGN_TOOLBAR_ITEMS.filter((i) => i.placement === "more");
const ids = (items: { id: string }[]) => items.map((i) => i.id);

describe("design toolbar overflow", () => {
  it("keeps every button in the bar when they fit", () => {
    const { shown, overflow } = splitBarItems(bar, more, bar.length + 1);
    expect(ids(shown)).toEqual(ids(bar));
    expect(overflow).toEqual([]);
  });

  it("moves the buttons that do not fit into More and keeps Chat and Layout", () => {
    const slots = 6;
    const { shown, overflow } = splitBarItems(bar, more, slots);
    expect(ids(shown)).toContain("chat");
    expect(ids(shown)).toContain("layout");
    // The More button takes the last slot.
    expect(shown.length + 1).toBe(slots);
    expect([...ids(shown), ...ids(overflow)].sort()).toEqual(ids(bar).sort());
    // The bar keeps its order; the overflow is its tail.
    expect(ids(overflow)).toEqual(ids(bar.filter((i) => !shown.includes(i))));
  });

  it("keeps the pane controls even with no room at all", () => {
    const { shown } = splitBarItems(bar, more, 0);
    expect(ids(shown)).toEqual(["layout", "chat"]);
  });
});
