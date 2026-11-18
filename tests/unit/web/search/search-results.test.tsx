/**
 * The Search panel's virtualised result list (`search-results.tsx`) and its rows
 * (`search-result-row.tsx`), mounted in happy-dom.
 *
 * happy-dom lays nothing out, so every element is 0 px tall and a virtualizer would
 * see no viewport at all. `offsetHeight` is stubbed: the scroller (`data-search-scroll`)
 * is 440 px, i.e. 20 desktop rows, and a row is as tall as its own inline `height`.
 * happy-dom's `scrollTo` moves `scrollTop` without firing `scroll`, so tests fire it.
 */
import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { act, createRef } from "react";
import { mount, click, type Mounted } from "../../../helpers/react-dom.tsx";
import { SearchResults, type SearchResultsHandle } from "../../../../src/web/components/explorer/search-results.tsx";
import { buildRows, matchKey, type SearchRow } from "../../../../src/web/lib/search/search-rows.ts";
import type { SearchMatch, SearchResponse } from "../../../../src/services/content-search/search-options.ts";
import type { ReplaceScope } from "../../../../src/web/lib/search/search-rows.ts";

const VIEWPORT = 440;

let restoreOffset: (() => void) | null = null;
beforeAll(() => {
  const proto = (globalThis as unknown as { HTMLElement: { prototype: object } }).HTMLElement.prototype;
  const prev = Object.getOwnPropertyDescriptor(proto, "offsetHeight");
  Object.defineProperty(proto, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.hasAttribute?.("data-search-scroll")) return VIEWPORT;
      const h = parseFloat(this.style?.height ?? "");
      return Number.isFinite(h) ? h : 0;
    },
  });
  restoreOffset = () => {
    if (prev) Object.defineProperty(proto, "offsetHeight", prev);
    else delete (proto as Record<string, unknown>).offsetHeight;
  };
});
afterAll(() => restoreOffset?.());

function m(line: number, column: number, text: string, extra: Partial<SearchMatch> = {}): SearchMatch {
  return { line, column, length: text.length, before: "x = ", cutBefore: false, text, after: ";", ...extra };
}

function response(results: SearchResponse["results"]): SearchResponse {
  const total = results.reduce((n, r) => n + r.matches.length, 0);
  return { results, total, files: results.length, limitHit: false, engine: "rg" };
}

/** 400 files × 50 matches = 20,000 matches, the result limit. */
function bigResponse(): SearchResponse {
  const results: SearchResponse["results"] = [];
  for (let f = 0; f < 400; f++) {
    const matches: SearchMatch[] = [];
    for (let i = 0; i < 50; i++) matches.push(m(i + 1, 4, "needle"));
    results.push({ file: `src/dir${String(f).padStart(3, "0")}/file.ts`, matches });
  }
  return response(results);
}

const SMALL = response([
  {
    file: "src/web/a.ts",
    matches: [
      m(3, 40, "UseStore", { before: "const project = ", cutBefore: true, after: "((s) => s.x);", replacement: "UseAppStore" }),
      m(9, 0, "useStore", { before: "", after: " = create()", replacement: "useAppStore" }),
    ],
  },
  { file: "src/web/stores/b.ts", matches: [m(1, 7, "useStore", { replacement: "useAppStore" })] },
]);

const listRows = (res: SearchResponse, collapsed: Set<string> = new Set()) =>
  buildRows(res, { viewMode: "list", dismissed: new Set(), collapsed });

interface Calls {
  focus: Array<string | null>;
  toggle: Array<[string, boolean]>;
  open: Array<[string, SearchMatch]>;
  dismiss: string[];
  replace: ReplaceScope[];
  copy: string[];
  collapseAll: number;
  exitTop: number;
}

function newCalls(): Calls {
  return { focus: [], toggle: [], open: [], dismiss: [], replace: [], copy: [], collapseAll: 0, exitTop: 0 };
}

interface RenderOpts {
  rows: SearchRow[];
  focusedRow?: string | null;
  hasReplace?: boolean;
  mobile?: boolean;
  calls?: Calls;
  handle?: React.RefObject<SearchResultsHandle | null>;
}

function element(o: RenderOpts, calls: Calls) {
  return (
    <SearchResults
      ref={o.handle}
      rows={o.rows}
      focusedRow={o.focusedRow ?? null}
      hasReplace={o.hasReplace ?? false}
      mobile={o.mobile ?? false}
      onFocusRow={(id) => calls.focus.push(id)}
      onToggle={(id, collapsed) => calls.toggle.push([id, collapsed])}
      onOpen={(file, match) => calls.open.push([file, match])}
      onDismiss={(id) => calls.dismiss.push(id)}
      onReplace={(scope) => calls.replace.push(scope)}
      onCopyPath={(file) => calls.copy.push(file)}
      onCollapseAll={() => calls.collapseAll++}
      onExitTop={() => calls.exitTop++}
    />
  );
}

async function render(o: RenderOpts): Promise<{ view: Mounted; calls: Calls }> {
  const calls = o.calls ?? newCalls();
  const view = await mount(element(o, calls));
  return { view, calls };
}

const scroller = (view: Mounted) => view.container.querySelector("[data-search-scroll]") as HTMLElement;
const rowEls = (view: Mounted) => [...view.container.querySelectorAll<HTMLElement>("[role=treeitem]")];
const rowById = (view: Mounted, id: string) =>
  rowEls(view).find((el) => el.getAttribute("data-row-id") === id) ?? null;
const button = (root: ParentNode | null, label: string) =>
  (root?.querySelector(`button[aria-label="${label}"]`) as HTMLElement | null) ?? null;

async function key(target: Element, init: KeyboardEventInit) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
}

async function scrollTo(view: Mounted, top: number) {
  const el = scroller(view);
  await act(async () => {
    el.scrollTop = top;
    el.dispatchEvent(new Event("scroll"));
  });
}

describe("virtualised list (7.8)", () => {
  it("renders only the rows in view for 20,000 matches", async () => {
    const rows = listRows(bigResponse());
    expect(rows.length).toBe(20_400);
    const { view } = await render({ rows });
    const shown = rowEls(view);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(100);
    expect(shown[0]!.getAttribute("data-row-id")).toBe(rows[0]!.id);
    await view.unmount();
  });

  it("renders the rows under the scroll position after a scroll", async () => {
    const rows = listRows(bigResponse());
    const { view } = await render({ rows });
    await scrollTo(view, 22 * 10_000);
    expect(rowById(view, rows[10_000]!.id)).not.toBeNull();
    expect(rowById(view, rows[0]!.id)).toBeNull();
    expect(rowEls(view).length).toBeLessThan(100);
    await view.unmount();
  });

  it("brings the focused row into view when focus moves far away", async () => {
    const rows = listRows(bigResponse());
    const calls = newCalls();
    const { view } = await render({ rows, calls });
    await view.rerender(element({ rows, focusedRow: rows[15_000]!.id }, calls));
    await act(async () => { scroller(view).dispatchEvent(new Event("scroll")); });
    expect(rowById(view, rows[15_000]!.id)).not.toBeNull();
    await view.unmount();
  });

  it("uses 22 px rows on desktop and 44 px rows on a phone", async () => {
    const rows = listRows(SMALL);
    const desk = await render({ rows });
    for (const el of rowEls(desk.view)) expect(el.style.height).toBe("22px");
    await desk.view.unmount();
    const phone = await render({ rows, mobile: true });
    for (const el of rowEls(phone.view)) expect(el.style.height).toBe("44px");
    await phone.view.unmount();
  });
});

describe("rows", () => {
  it("shows a match's preview with an ellipsis and highlights exactly the server's text", async () => {
    const rows = listRows(SMALL);
    const { view } = await render({ rows });
    const first = rowById(view, matchKey("src/web/a.ts", SMALL.results[0]!.matches[0]!))!;
    expect(first.textContent).toContain("…");
    expect(first.textContent).toContain("const project = UseStore((s) => s.x);");
    const marks = first.querySelectorAll("mark");
    expect(marks.length).toBe(1);
    expect(marks[0]!.textContent).toBe("UseStore");
    const second = rowById(view, matchKey("src/web/a.ts", SMALL.results[0]!.matches[1]!))!;
    expect(second.textContent).not.toContain("…");
    expect(second.querySelector("mark")!.textContent).toBe("useStore");
    await view.unmount();
  });

  it("strikes the old text through beside the new one when a replace is set (5.1)", async () => {
    const rows = listRows(SMALL);
    const { view } = await render({ rows, hasReplace: true });
    const first = rowById(view, matchKey("src/web/a.ts", SMALL.results[0]!.matches[0]!))!;
    expect(first.querySelector("del")!.textContent).toBe("UseStore");
    expect(first.querySelector("ins")!.textContent).toBe("UseAppStore");
    expect(first.querySelector("mark")).toBeNull();
    await view.unmount();
  });

  it("shows a match without a computed replacement as a plain hit", async () => {
    const res = response([{ file: "a.ts", matches: [m(1, 4, "foo")] }]);
    const { view } = await render({ rows: listRows(res), hasReplace: true });
    const row = rowById(view, matchKey("a.ts", res.results[0]!.matches[0]!))!;
    expect(row.querySelector("mark")!.textContent).toBe("foo");
    expect(row.querySelector("ins")).toBeNull();
    await view.unmount();
  });

  it("names a file with its folder in list view, with its count", async () => {
    const { view } = await render({ rows: listRows(SMALL) });
    const file = rowById(view, "src/web/a.ts")!;
    expect(file.textContent).toContain("a.ts");
    expect(file.textContent).toContain("src/web");
    expect(file.textContent).toContain("2");
    expect(file.getAttribute("aria-expanded")).toBe("true");
    await view.unmount();
  });

  it("shows folders in tree view, nested by level", async () => {
    const rows = buildRows(SMALL, { viewMode: "tree", dismissed: new Set(), collapsed: new Set() });
    const { view } = await render({ rows });
    const folder = rowEls(view).find((el) => el.getAttribute("data-kind") === "folder")!;
    expect(folder.textContent).toContain("src/web");
    expect(folder.getAttribute("aria-level")).toBe("1");
    const file = rowById(view, "src/web/a.ts")!;
    expect(Number(file.getAttribute("aria-level"))).toBeGreaterThan(1);
    await view.unmount();
  });

  it("opens a match on click and toggles a file on click", async () => {
    const rows = listRows(SMALL);
    const { view, calls } = await render({ rows });
    const match = SMALL.results[0]!.matches[1]!;
    await click(rowById(view, matchKey("src/web/a.ts", match)));
    expect(calls.open).toEqual([["src/web/a.ts", match]]);
    expect(calls.focus).toContain(matchKey("src/web/a.ts", match));
    await click(rowById(view, "src/web/a.ts"));
    expect(calls.toggle).toEqual([["src/web/a.ts", true]]);
    await view.unmount();
  });
});

describe("row actions (4.3, 4.4)", () => {
  it("offers Dismiss on a match, and Replace only when a replace text is set", async () => {
    const rows = listRows(SMALL);
    const id = matchKey("src/web/a.ts", SMALL.results[0]!.matches[0]!);
    const plain = await render({ rows });
    expect(button(rowById(plain.view, id), "Dismiss")).not.toBeNull();
    expect(button(rowById(plain.view, id), "Replace")).toBeNull();
    await plain.view.unmount();

    const { view, calls } = await render({ rows, hasReplace: true });
    await click(button(rowById(view, id), "Replace"));
    await click(button(rowById(view, id), "Dismiss"));
    expect(calls.replace).toEqual([{ match: id }]);
    expect(calls.dismiss).toEqual([id]);
    expect(calls.open).toEqual([]);
    await view.unmount();
  });

  it("offers Replace All in File, Copy Path and Dismiss on a file", async () => {
    const rows = listRows(SMALL);
    const { view, calls } = await render({ rows, hasReplace: true });
    const file = rowById(view, "src/web/a.ts");
    await click(button(file, "Replace All in File"));
    await click(button(file, "Copy Path"));
    await click(button(file, "Dismiss"));
    expect(calls.replace).toEqual([{ file: "src/web/a.ts" }]);
    expect(calls.copy).toEqual(["src/web/a.ts"]);
    expect(calls.dismiss).toEqual(["src/web/a.ts"]);
    expect(calls.toggle).toEqual([]);
    await view.unmount();

    const plain = await render({ rows });
    expect(button(rowById(plain.view, "src/web/a.ts"), "Replace All in File")).toBeNull();
    expect(button(rowById(plain.view, "src/web/a.ts"), "Copy Path")).not.toBeNull();
    await plain.view.unmount();
  });

  it("shows actions only on hover or focus on desktop, always on a phone (6.7)", async () => {
    const rows = listRows(SMALL);
    const id = matchKey("src/web/a.ts", SMALL.results[0]!.matches[0]!);
    const desk = await render({ rows, hasReplace: true });
    expect(rowById(desk.view, id)!.querySelector("[data-actions]")!.getAttribute("data-actions")).toBe("hover");
    await desk.view.unmount();

    const phone = await render({ rows, hasReplace: true, mobile: true });
    const row = rowById(phone.view, id)!;
    expect(row.querySelector("[data-actions]")!.getAttribute("data-actions")).toBe("always");
    for (const label of ["Replace", "Dismiss"]) {
      expect(button(row, label)!.className).toContain("size-11");
    }
    await phone.view.unmount();
  });

  it("opens a bottom sheet from a file's ··· on a phone", async () => {
    const rows = listRows(SMALL);
    const { view, calls } = await render({ rows, hasReplace: true, mobile: true });
    const file = rowById(view, "src/web/a.ts")!;
    expect(button(file, "Copy Path")).toBeNull();
    const more = button(file, "More actions")!;
    expect(more.className).toContain("size-11");
    await click(more);
    const sheet = document.querySelector("[data-search-file-sheet]");
    expect(sheet).not.toBeNull();
    for (const label of ["Replace All in File", "Copy Path", "Dismiss", "Collapse All"]) {
      expect(sheet!.textContent).toContain(label);
    }
    const copy = [...sheet!.querySelectorAll("button")].find((b) => b.textContent?.includes("Copy Path"))!;
    await click(copy);
    expect(calls.copy).toEqual(["src/web/a.ts"]);
    expect(document.querySelector("[data-search-file-sheet]")).toBeNull();
    await click(button(rowById(view, "src/web/a.ts"), "More actions"));
    const collapse = [...document.querySelectorAll("[data-search-file-sheet] button")].find((b) =>
      b.textContent?.includes("Collapse All"),
    )!;
    await click(collapse);
    expect(calls.collapseAll).toBe(1);
    await view.unmount();
  });
});

describe("keyboard (6.1)", () => {
  const rows = listRows(SMALL);
  const fileA = "src/web/a.ts";
  const m0 = matchKey(fileA, SMALL.results[0]!.matches[0]!);
  const m1 = matchKey(fileA, SMALL.results[0]!.matches[1]!);

  it("moves with the arrows and opens with Enter", async () => {
    const { view, calls } = await render({ rows, focusedRow: m0 });
    const list = scroller(view);
    await key(list, { key: "ArrowDown" });
    await key(list, { key: "ArrowUp" });
    expect(calls.focus).toEqual([m1, fileA]);
    await key(list, { key: "Enter" });
    expect(calls.open).toEqual([[fileA, SMALL.results[0]!.matches[0]!]]);
    await view.unmount();
  });

  it("collapses with Left and expands with Right", async () => {
    const calls = newCalls();
    const open = await render({ rows, focusedRow: fileA, calls });
    await key(scroller(open.view), { key: "ArrowLeft" });
    expect(calls.toggle).toEqual([[fileA, true]]);
    await open.view.unmount();

    const shut = await render({ rows: listRows(SMALL, new Set([fileA])), focusedRow: fileA, calls });
    await key(scroller(shut.view), { key: "ArrowRight" });
    expect(calls.toggle).toEqual([[fileA, true], [fileA, false]]);
    await shut.view.unmount();
  });

  it("dismisses the focused row with Delete and moves focus to the next row", async () => {
    const { view, calls } = await render({ rows, focusedRow: m0 });
    await key(scroller(view), { key: "Delete" });
    expect(calls.dismiss).toEqual([m0]);
    expect(calls.focus.at(-1)).toBe(m1);
    await view.unmount();

    const file = await render({ rows, focusedRow: fileA });
    await key(scroller(file.view), { key: "Delete" });
    expect(file.calls.dismiss).toEqual([fileA]);
    expect(file.calls.focus.at(-1)).toBe("src/web/stores/b.ts");
    await file.view.unmount();
  });

  it("replaces the focused match or file with Ctrl+Shift+1, only when a replace is set", async () => {
    const plain = await render({ rows, focusedRow: m0 });
    await key(scroller(plain.view), { key: "!", code: "Digit1", ctrlKey: true, shiftKey: true });
    expect(plain.calls.replace).toEqual([]);
    await plain.view.unmount();

    const calls = newCalls();
    const a = await render({ rows, focusedRow: m0, hasReplace: true, calls });
    await key(scroller(a.view), { key: "!", code: "Digit1", ctrlKey: true, shiftKey: true });
    await a.view.unmount();
    const b = await render({ rows, focusedRow: fileA, hasReplace: true, calls });
    await key(scroller(b.view), { key: "!", code: "Digit1", ctrlKey: true, shiftKey: true });
    await b.view.unmount();
    expect(calls.replace).toEqual([{ match: m0 }, { file: fileA }]);
  });

  it("hands focus back to the field on Up from the first row", async () => {
    const { view, calls } = await render({ rows, focusedRow: fileA });
    await key(scroller(view), { key: "ArrowUp" });
    expect(calls.exitTop).toBe(1);
    await view.unmount();
  });

  it("takes focus through its handle, focusing the first row when none is", async () => {
    const handle = createRef<SearchResultsHandle>();
    const { view, calls } = await render({ rows, handle });
    await act(async () => handle.current!.focus());
    expect(document.activeElement).toBe(scroller(view));
    expect(calls.focus).toEqual([fileA]);
    await view.unmount();
  });

  it("marks the focused row for assistive tech", async () => {
    const { view } = await render({ rows, focusedRow: m1 });
    const list = scroller(view);
    expect(list.getAttribute("role")).toBe("tree");
    const focused = rowById(view, m1)!;
    expect(focused.getAttribute("aria-selected")).toBe("true");
    expect(list.getAttribute("aria-activedescendant")).toBe(focused.id);
    await view.unmount();
  });
});
