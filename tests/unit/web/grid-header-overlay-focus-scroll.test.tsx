/**
 * The header layer places its slots by a transform that follows the grid's scroll, inside boxes that
 * clip them. A clipping box is still something a browser scrolls to show what is in it: in Chromium
 * at 390 × 844, bringing the ⌄ of the column half off the right edge into view scrolled the clip box
 * 25 px, and every ⌄ sat 25 px left of its column from then on, the canvas unmoved. Tab reaching a
 * filter box off the grid's edge does the same. The layer puts such a scroll back at once and asks
 * the grid to scroll to the column the browser was showing: the one it scrolled under the box's
 * right edge.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { act } = await import("react");
const { GridHeaderOverlay, columnAtRightEdge, columnOffsets } = await import("../../../src/web/components/database/grid/grid-header-overlay.tsx");

// Columns a–d start at 0, 100, 180 and 300.
const COLUMNS = [{ id: "a", width: 100 }, { id: "b", width: 80 }, { id: "c", width: 120 }, { id: "d", width: 60 }];
/** How wide the clip box is: c is cut at its right edge, d wholly past it. */
const BOX_WIDTH = 250;

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

/** Mounts the layer and answers its two boxes: the clip box around the moving row of slots, and the layer's own. */
async function mountOverlay(onRevealColumn?: (index: number) => void) {
  mounted = await mount(
    <GridHeaderOverlay
      columns={COLUMNS} freezeColumns={0} markerWidth={32} height={44}
      renderSlot={(c) => <button type="button">Column menu: {c.id}</button>}
      onRevealColumn={onRevealColumn}
    />,
  );
  const button = mounted.container.querySelector("button")!;
  // slot → row of slots → clip box → the layer.
  const clip = button.parentElement!.parentElement!.parentElement!;
  Object.defineProperty(clip, "clientWidth", { value: BOX_WIDTH, configurable: true });
  return { clip, layer: clip.parentElement! };
}

/** What a browser does to show something in a box: scroll it, which then reports a scroll. */
async function scrollToShow(box: HTMLElement, left: number, top = 0) {
  await act(async () => {
    box.scrollLeft = left;
    box.scrollTop = top;
    box.dispatchEvent(new Event("scroll"));
  });
}

describe("a box the browser scrolled to show a slot", () => {
  it("is put back where it was, so every slot stays over its own column", async () => {
    const { clip } = await mountOverlay(() => {});
    await scrollToShow(clip, 25, 3);
    expect(clip.scrollLeft).toBe(0);
    expect(clip.scrollTop).toBe(0);
  });

  it("has the grid scroll to the column it brought under its right edge", async () => {
    const asked: number[] = [];
    const { clip } = await mountOverlay((index) => asked.push(index));
    // Showing the end of c, which was cut at the edge.
    await scrollToShow(clip, 25);
    // Showing all of d, which was wholly past it.
    await scrollToShow(clip, 110);
    expect(asked).toEqual([2, 3]);
  });

  it("does the same when the scroll lands on the layer's own box", async () => {
    const asked: number[] = [];
    const { layer } = await mountOverlay((index) => asked.push(index));
    await scrollToShow(layer, 110);
    expect(layer.scrollLeft).toBe(0);
    expect(asked).toEqual([3]);
  });

  it("asks nothing of the grid for the frozen columns' box, which never leave the view", async () => {
    const asked: number[] = [];
    mounted = await mount(
      <GridHeaderOverlay
        columns={COLUMNS} freezeColumns={1} markerWidth={32} height={44}
        renderSlot={(c) => <button type="button">Column menu: {c.id}</button>}
        onRevealColumn={(index) => asked.push(index)}
      />,
    );
    // The frozen columns' box comes after the clip box in the layer.
    const frozen = mounted.container.firstElementChild!.lastElementChild as HTMLElement;
    expect(frozen.textContent).toBe("Column menu: a");
    await scrollToShow(frozen, 30);
    expect(frozen.scrollLeft).toBe(0);
    expect(asked).toEqual([]);
  });

  it("asks nothing of the grid for a scroll that moved nothing sideways", async () => {
    const asked: number[] = [];
    const { clip } = await mountOverlay((index) => asked.push(index));
    await scrollToShow(clip, 0, 4);
    expect(clip.scrollTop).toBe(0);
    expect(asked).toEqual([]);
  });
});

describe("columnAtRightEdge", () => {
  const offsets = columnOffsets(COLUMNS);

  it("is the column under the box's right edge", () => {
    expect(columnAtRightEdge(offsets, 0, 0, BOX_WIDTH)).toBe(2);
    expect(columnAtRightEdge(offsets, 0, 0, 100)).toBe(0);
    expect(columnAtRightEdge(offsets, 0, 0, 101)).toBe(1);
  });

  it("counts the scroll the grid already had along with the browser's", () => {
    expect(columnAtRightEdge(offsets, 0, 60, BOX_WIDTH)).toBe(3);
  });

  it("counts from the first column that is not frozen", () => {
    // a frozen: the scrolling part starts at b, so a 100px box shows b and the start of c.
    expect(columnAtRightEdge(offsets, 1, 0, 100)).toBe(2);
  });

  it("is nothing when no column is there", () => {
    expect(columnAtRightEdge([], 0, 0, BOX_WIDTH)).toBeNull();
  });
});
