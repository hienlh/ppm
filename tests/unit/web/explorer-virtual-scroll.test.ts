/**
 * The Source Control... no: the *file* explorer's virtual scroller, after the pass
 * that took React off the scroll path.
 *
 * The tree was always virtualized, so "add virtualization" was never the fix. What
 * cost the frames was that `@tanstack/react-virtual` defaults `directDomUpdates`
 * to false, and in that mode every scroll event ends in `flushSync(rerender)` —
 * so the whole mounted row set is reconciled *synchronously inside the scroll
 * handler*. Measured on a 6x-throttled CPU over 1191 rows: 92ms of a 137ms long
 * animation frame was attributed to `DIV.onscroll`, style and layout together 4ms.
 * With the flag on, zero long animation frames.
 *
 * Everything below is asserted against the source rather than a render, because
 * these are four separate settings that only work as a set: turn the flag on but
 * leave the row writing its own `transform` and the two fight; take
 * `measureElement` off and direct updates lose the map they look rows up in
 * (`elementsCache` is populated by that very ref callback). Each one alone reads
 * as correct in review, and the failure is a tree that renders every row at the
 * top of the list.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(import.meta.dir, "../../../src/web", p), "utf8");
const tree = read("components/explorer/file-tree.tsx");
const row = read("components/explorer/tree-node.tsx");

/** The `useVirtualizer({...})` call, so a match cannot come from somewhere else. */
const virtualizerOptions = (() => {
  const i = tree.indexOf("useVirtualizer({");
  if (i < 0) throw new Error("the explorer no longer calls useVirtualizer");
  const j = tree.indexOf("});", i);
  return tree.slice(i, j);
})();

/** The JSX of one virtual row, from its `data-index` to the end of its props. */
const rowElement = (() => {
  const i = tree.indexOf("data-index={vi.index}");
  if (i < 0) throw new Error("no virtual row in the explorer");
  return tree.slice(i, tree.indexOf(">", tree.indexOf("className", i)));
})();

describe("React is off the scroll path", () => {
  it("asks the virtualizer to write positions itself", () => {
    expect(virtualizerOptions).toMatch(/directDomUpdates:\s*true/);
  });

  it("does not also position the row from React", () => {
    // The virtualizer owns `transform` in this mode. A row that writes its own
    // fights it on every range change, which shows up as rows that jump back.
    expect(rowElement).not.toMatch(/transform/);
    expect(rowElement).toMatch(/absolute left-0 top-0/); // what the mode requires
  });

  it("hands the sizing container to the virtualizer instead of setting a height", () => {
    expect(tree).toMatch(/ref=\{rowVirtualizer\.containerRef\}/);
    expect(tree).not.toMatch(/style=\{\{\s*height:\s*rowVirtualizer\.getTotalSize\(\)/);
  });

  it("keeps measureElement, which is what direct updates look rows up by", () => {
    // `elementsCache` is written inside this ref callback; without it
    // `applyDirectStyles` finds no node and no row is ever positioned.
    expect(tree).toMatch(/ref=\{rowVirtualizer\.measureElement\}/);
  });
});

describe("a row is exactly as tall as the virtualizer is told", () => {
  it("pins the line box so the estimate is not corrected on every scroll", () => {
    // 13px text with the inherited line-height of 1.5 is a 19.5px line box, so
    // the row measured 27.5px against an estimate of 26 — and every row entering
    // the viewport re-measured and moved the total size under the scrollbar.
    expect(row).toMatch(/text-\[13px\] leading-\[18px\]/);
  });

  it("agrees with estimateSize at both breakpoints", () => {
    // desktop: 18px line box + py-1 (8px) = 26, which is also the min-height.
    // mobile: the 32px min-height wins over the same 26.
    expect(row).toMatch(/min-h-\[32px\] md:min-h-\[26px\]/);
    expect(virtualizerOptions).toMatch(/estimateSize:\s*\(\)\s*=>\s*\(isMobile \? 32 : 26\)/);
  });
});

describe("the row's props do not defeat its own memo", () => {
  it("passes a stable onAction", () => {
    // TreeRow is memo()'d and this is one of its props: a plain `async function`
    // in the component body is a new identity per render, so the memo never hit
    // and every mounted row re-rendered whatever changed.
    expect(tree).toMatch(/const handleAction = useCallback\(/);
    expect(tree).not.toMatch(/async function handleAction\(/);
  });

  it("reads the selection at call time rather than closing over it", () => {
    // As a dependency it would rebuild the callback on every click — selecting a
    // file is the commonest thing that happens in this panel.
    const body = tree.slice(tree.indexOf("const handleAction = useCallback("));
    const deps = body.slice(body.indexOf("}, ["), body.indexOf("]);") + 3);
    expect(deps).not.toMatch(/selectedFiles/);
    expect(body.slice(0, 400)).toMatch(/useFileStore\.getState\(\)\.selectedFiles/);
  });
});

describe("one context menu for the tree, not one per row", () => {
  it("leaves the row with no menu of its own", () => {
    // Every mounted row used to build this menu's 39 items on every render, and
    // subscribed to a fifth store purely to feed it. VS Code has one
    // `tree.onContextMenu` for the whole list.
    expect(row).not.toMatch(/ContextMenuTrigger/);
    expect(row).not.toMatch(/TreeNodeContextMenu/);
    expect(row).not.toMatch(/useCompareStore/);
  });

  it("builds the menu once, from whichever row the gesture landed on", () => {
    expect(tree).toMatch(/<TreeNodeContextMenu/);
    expect(tree).toMatch(/menuNode \? \(/); // node menu, else the tree's own
  });

  it("resolves the row from the DOM, since no row component is involved by then", () => {
    const fn = tree.slice(tree.indexOf("const rememberMenuTarget"));
    const body = fn.slice(0, fn.indexOf("\n  );"));
    expect(body).toMatch(/closest\?\.\("\[data-index\]"\)/);
    expect(body).toMatch(/rowsRef\.current\[index\]/);
    // Identity check, or every tap on the same row would cost a render.
    expect(body).toMatch(/prev === node \? prev : node/);
  });

  it("listens on both of the events that precede it opening", () => {
    // `contextmenu` is the mouse. Touch resolves from `pointerdown`, which a
    // finger fires before `touchstart` — and the long-press timer that opens the
    // sheet runs 400ms after that, so the target has landed in time. Listening on
    // `touchstart` as well was tried and removed: it guards a browser with no
    // pointer events, and it trips `long-press-touchcancel.test.ts`, which reads
    // any file naming `onTouchStart` beside a `setTimeout` as an armed press.
    expect(tree).toMatch(/onContextMenuCapture=\{rememberMenuTarget\}/);
    expect(tree).toMatch(/onPointerDownCapture=\{rememberMenuTarget\}/);
    expect(tree).not.toMatch(/onTouchStartCapture/);
  });
});

describe("a row's identity is its path, not its position", () => {
  // Direct updates position a row by looking its DOM node up in `elementsCache`,
  // which the virtualizer keys with `getItemKey` — the index, by default. React
  // keys these rows by path, so it reuses a node when a row merely shifts index
  // and never calls the `measureElement` ref again. Expanding a folder therefore
  // left every row below it registered under the slot it used to occupy: the
  // inserted rows took over those entries and the shifted ones matched nothing,
  // so `applyDirectStyles` skipped them and they stayed at their old offsets.
  // Reproduced against the built bundle: expanding `.husky` put two pairs of
  // rows on exactly the same y.
  it("gives the virtualizer the same key React uses", () => {
    expect(virtualizerOptions).toMatch(/getItemKey:\s*\(index\)\s*=>/);
    expect(virtualizerOptions).toMatch(/rowKey\(r\)/);
    expect(tree).toMatch(/key=\{rowKey\(row\)\}/);
  });

  it("keeps that key in one place, so the two cannot drift apart", () => {
    const flatten = read("components/explorer/flatten-visible-tree.ts");
    expect(flatten).toMatch(/export function rowKey\(row: FlatRow\): string/);
    // The explorer must not spell the key out a second time.
    expect(tree.replace(/rowKey\(/g, "")).not.toMatch(/input:\$\{/);
  });

  it("does not throw for an index the list no longer has", () => {
    // `measureElement` takes the index off the DOM, so a ResizeObserver firing
    // for a row React has not unmounted yet can ask for one past the end.
    expect(virtualizerOptions).not.toMatch(/rowKey\(rows\[index\]!\)/);
    expect(virtualizerOptions).toMatch(/r \? rowKey\(r\) : /);
  });
});
