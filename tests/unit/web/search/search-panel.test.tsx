/**
 * The Search panel (`search-panel.tsx`), mounted in happy-dom against the real search store and
 * a fake search client, so every request the panel makes is recorded rather than sent.
 *
 * Covers what the panel itself owns: the toolbar (Refresh, Clear, Collapse/Expand All, View as
 * Tree/List), the option toggles and their Alt shortcuts, the replace and details folds with the
 * filters-active dot, the status line and banners (limit, timeout, grep, errors with Retry, the
 * engine's regex error under the field), the query history keys, ↓ into the results, and one
 * match / one file replace reported in the status line.
 *
 * happy-dom lays nothing out, so `offsetHeight` is stubbed as in `search-results.test.tsx`: the
 * results scroller is 440 px and a row is as tall as its inline `height`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { click, installGlobal, mount, uninstallDom, type Mounted } from "../../../helpers/react-dom.tsx";
import { SearchPanel } from "../../../../src/web/components/explorer/search-panel.tsx";
import { useSearchStore, getSearchState, type SearchState } from "../../../../src/web/stores/search-store.ts";
import { useProjectStore } from "../../../../src/web/stores/project-store.ts";
import { useTabStore } from "../../../../src/web/stores/tab-store.ts";
import { clearEditor, setEditorUnsaved } from "../../../../src/web/lib/open-editors-registry.ts";
import { matchKey } from "../../../../src/web/lib/search/search-rows.ts";
import type { SearchClient } from "../../../../src/web/lib/search/search-client.ts";
import type {
  ReplaceReport,
  ReplaceRequest,
  SearchMatch,
  SearchResponse,
} from "../../../../src/services/content-search/search-options.ts";

const P = "proj";
const VIEWPORT = 440;

// Radix's focus scope, inside the Replace All dialog, watches its content with one.
installGlobal("MutationObserver", window.MutationObserver);

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
afterAll(() => {
  restoreOffset?.();
  uninstallDom();
});

function m(line: number, column: number, text = "useStore", extra: Partial<SearchMatch> = {}): SearchMatch {
  return { line, column, length: text.length, before: "x = ", cutBefore: false, text, after: ";", ...extra };
}

function response(results: SearchResponse["results"], extra: Partial<SearchResponse> = {}): SearchResponse {
  const total = results.reduce((n, r) => n + r.matches.length, 0);
  return { results, total, files: results.length, limitHit: false, engine: "rg", ...extra };
}

const R = (s: string) => ({ replacement: s });
const SMALL = response([
  { file: "src/a.ts", matches: [m(3, 4, "useStore", R("useAppStore")), m(9, 0, "useStore", R("useAppStore"))] },
  { file: "src/b.ts", matches: [m(1, 7, "useStore", R("useAppStore"))] },
]);

interface Calls {
  schedule: string[];
  searchNow: string[];
  cancel: string[];
  warmUp: string[];
  replace: Array<{ project: string; files: ReplaceRequest["files"] }>;
}

let calls: Calls;
let nextReport: ReplaceReport | Error | null;
let client: SearchClient;
let view: Mounted | null;
let opened: Array<Record<string, unknown>>;
let navigated: number;
const realOpenTab = useTabStore.getState().openTab;
const realUpdateTab = useTabStore.getState().updateTab;

function fakeClient(): SearchClient {
  return {
    schedule: (p) => { calls.schedule.push(p); },
    searchNow: async (p) => { calls.searchNow.push(p); },
    cancel: (p) => { calls.cancel.push(p); },
    warmUp: (p) => { calls.warmUp.push(p); },
    replace: async (project, files) => {
      calls.replace.push({ project, files });
      const report = nextReport;
      if (report instanceof Error) throw report;
      if (report) return report;
      const replaced = files.reduce((n, f) => n + f.matches.length, 0);
      return { replaced, files: files.length, skipped: [], failed: [] };
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  calls = { schedule: [], searchNow: [], cancel: [], warmUp: [], replace: [] };
  nextReport = null;
  client = fakeClient();
  opened = [];
  navigated = 0;
  view = null;
  useSearchStore.setState({ projects: {}, history: {}, viewMode: "list" });
  useProjectStore.setState({ activeProject: { name: P, path: "/tmp/proj" } as never });
  useTabStore.setState({
    openTab: ((tab: Record<string, unknown>) => { opened.push(tab); return "tab-1"; }) as never,
    updateTab: (() => {}) as never,
  });
});

afterEach(async () => {
  await view?.unmount();
  view = null;
  clearEditor("editor-1");
  useTabStore.setState({ openTab: realOpenTab, updateTab: realUpdateTab });
});

function seed(patch: Partial<SearchState>) {
  useSearchStore.getState().update(P, patch);
}

async function render(opts: { mobile?: boolean } = {}) {
  view = await mount(<SearchPanel client={client} mobile={opts.mobile ?? false} onNavigate={() => navigated++} />);
  return view;
}

const $ = <T extends Element = HTMLElement>(sel: string) => view!.container.querySelector<T>(sel);
const byLabel = (label: string) => $<HTMLElement>(`[aria-label="${label}"]`);
const searchInput = () => byLabel("Search") as HTMLInputElement;
const text = () => (view!.container.textContent ?? "").replace(/\s+/g, " ");
const status = () => ($("[data-search-status]")?.textContent ?? "").replace(/\s+/g, " ").trim();
const state = () => getSearchState(P);

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(target: Element, init: KeyboardEventInit) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
}

async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe("query and options", () => {
  it("warms the search host once on mount and focuses the field", async () => {
    await render();
    expect(calls.warmUp).toEqual([P]);
    expect(document.activeElement).toBe(searchInput());
  });

  it("puts what is typed in the store and schedules a search", async () => {
    await render();
    await type(searchInput(), "useStore");
    expect(state().query).toBe("useStore");
    expect(calls.schedule).toEqual([P]);
  });

  it("shows the project's last query, options and results when it mounts again (6.5)", async () => {
    seed({ query: "kept", regex: true, response: SMALL, status: "done" });
    await render();
    expect(searchInput().value).toBe("kept");
    expect(byLabel("Use Regular Expression")!.getAttribute("aria-pressed")).toBe("true");
    expect(status()).toContain("3 results in 2 files");
  });

  it("toggles Match Case, Whole Word and Regex with Alt+C/W/R, and lets Whole Word and Regex combine (3.1, 3.5)", async () => {
    await render();
    const input = searchInput();
    // macOS turns Alt+letter into another character, so the physical key is what counts.
    await key(input, { altKey: true, code: "KeyC", key: "ç" });
    await key(input, { altKey: true, code: "KeyW", key: "∑" });
    await key(input, { altKey: true, code: "KeyR", key: "®" });
    expect(state().caseSensitive).toBe(true);
    expect(state().wholeWord).toBe(true);
    expect(state().regex).toBe(true);
    expect(byLabel("Match Case")!.getAttribute("aria-pressed")).toBe("true");
    expect(byLabel("Match Whole Word")!.getAttribute("aria-pressed")).toBe("true");
    expect(byLabel("Use Regular Expression")!.getAttribute("aria-pressed")).toBe("true");
    expect(calls.schedule.length).toBe(3);

    await key(input, { altKey: true, code: "KeyW", key: "∑" });
    expect(state().wholeWord).toBe(false);
    expect(state().regex).toBe(true);
  });

  it("keeps the option buttons' titles naming their shortcut", async () => {
    await render();
    expect($('button[title="Use Regular Expression (Alt+R)"]')).not.toBeNull();
    expect($('button[title="Match Case (Alt+C)"]')).not.toBeNull();
    expect($('button[title="Match Whole Word (Alt+W)"]')).not.toBeNull();
  });

  it("toggles Preserve Case with Alt+P while the replace field is open", async () => {
    seed({ showReplace: true });
    await render();
    await key(searchInput(), { altKey: true, code: "KeyP", key: "π" });
    expect(state().preserveCase).toBe(true);
    expect(byLabel("Preserve Case")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("runs the search again at once on Enter", async () => {
    seed({ query: "x" });
    await render();
    await key(searchInput(), { key: "Enter", code: "Enter" });
    expect(calls.searchNow).toEqual([P]);
  });
});

describe("per project", () => {
  it("shows each project's own last search when the active project changes (6.6)", async () => {
    useSearchStore.getState().update("other", { query: "otherQuery" });
    seed({ query: "useStore", response: SMALL });
    await render();
    expect(searchInput().value).toBe("useStore");
    expect(text()).toContain("a.ts");

    await act(async () => { useProjectStore.setState({ activeProject: { name: "other", path: "/tmp/other" } as never }); });
    await settle();
    expect(searchInput().value).toBe("otherQuery");
    expect(text()).not.toContain("a.ts");

    await act(async () => { useProjectStore.setState({ activeProject: { name: P, path: "/tmp/proj" } as never }); });
    await settle();
    expect(searchInput().value).toBe("useStore");
    expect(text()).toContain("a.ts");
  });
});

describe("replace and details folds", () => {
  it("shows and hides the replace field with the chevron, and searches again with the replacement", async () => {
    seed({ query: "useStore" });
    await render();
    const toggle = byLabel("Toggle Replace")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(byLabel("Replace")).toBeNull();
    await click(toggle);
    expect(state().showReplace).toBe(true);
    expect(byLabel("Replace")).not.toBeNull();
    await type(byLabel("Replace") as HTMLInputElement, "useAppStore");
    expect(state().replace).toBe("useAppStore");
    expect(calls.schedule.length).toBeGreaterThanOrEqual(2);
  });

  it("opens the details with include, exclude and the ignore-files toggle, each searching again (2.1–2.4)", async () => {
    seed({ query: "q" });
    await render();
    expect(byLabel("Files to include")).toBeNull();
    await click(byLabel("Toggle Search Details"));
    expect(state().showDetails).toBe(true);
    await type(byLabel("Files to include") as HTMLInputElement, "src/**");
    await type(byLabel("Files to exclude") as HTMLInputElement, "*.test.ts");
    const ignore = byLabel("Use Exclude Settings and Ignore Files")!;
    expect(ignore.getAttribute("aria-pressed")).toBe("true");
    await click(ignore);
    expect(state()).toMatchObject({ include: "src/**", exclude: "*.test.ts", useIgnore: false });
    expect(calls.schedule.length).toBe(3);
  });

  it("marks the details toggle while a filter applies with the fields folded (2.6)", async () => {
    await render();
    const toggle = () => byLabel("Toggle Search Details")!;
    expect(toggle().querySelector("[data-filter-dot]")).toBeNull();
    await act(async () => seed({ include: "src/**", showDetails: false }));
    expect(toggle().querySelector("[data-filter-dot]")).not.toBeNull();
    await act(async () => seed({ include: "", useIgnore: false }));
    expect(toggle().querySelector("[data-filter-dot]")).not.toBeNull();
    await act(async () => seed({ useIgnore: true }));
    expect(toggle().querySelector("[data-filter-dot]")).toBeNull();
  });
});

describe("status line and banners", () => {
  it("says Searching… while a search runs", async () => {
    seed({ query: "q", status: "searching" });
    await render();
    expect(status()).toContain("Searching");
  });

  it("counts every listed match, leaving dismissed ones out (1.6)", async () => {
    seed({ query: "useStore", response: SMALL, status: "done", dismissed: new Set([matchKey("src/b.ts", SMALL.results[1]!.matches[0]!)]) });
    await render();
    expect(status()).toContain("2 results in 1 file");
  });

  it("says No results found for an empty answer", async () => {
    seed({ query: "zzz", response: response([]), status: "done" });
    await render();
    expect(status()).toContain("No results found");
  });

  it("keeps the matches and says the result set was cut short at the limit (1.3)", async () => {
    seed({ query: "e", response: { ...SMALL, limitHit: true }, status: "done" });
    await render();
    const banner = $("[data-search-banner=limit]");
    expect(banner?.textContent).toContain("The result set only contains a subset of all matches");
    expect(status()).toContain("3 results in 2 files");
  });

  it("keeps the matches found before the time limit and offers Search again (1.4)", async () => {
    seed({ query: "e", response: { ...SMALL, incomplete: "timeout" }, status: "done" });
    await render();
    const banner = $("[data-search-banner=timeout]")!;
    expect(banner.textContent).toContain("may be incomplete");
    expect(status()).toContain("3 results in 2 files");
    const again = [...banner.querySelectorAll("button")].find((b) => b.textContent?.includes("Search again"));
    await click(again ?? null);
    expect(calls.searchNow).toEqual([P]);
  });

  it("says when the search ran with grep instead of ripgrep", async () => {
    seed({ query: "e", response: { ...SMALL, engine: "grep" }, status: "done" });
    await render();
    expect($("[data-search-banner=grep]")?.textContent).toContain("grep");
  });

  it("marks the field and shows the engine's own reason for a bad regex, with no Retry (3.2)", async () => {
    seed({ query: "foo(?<name", regex: true, status: "error", error: { status: 400, message: "regex parse error: unclosed group name" } });
    await render();
    expect(searchInput().getAttribute("aria-invalid")).toBe("true");
    expect($("[data-search-field-error]")?.textContent).toContain("regex parse error: unclosed group name");
    expect($("[data-search-banner=error]")).toBeNull();
  });

  it("shows a searcher that could not start as an error with Retry (7.5)", async () => {
    seed({ query: "q", status: "error", error: { status: 503, message: "Search could not start: the search process exited (code 1)." } });
    await render();
    expect(searchInput().getAttribute("aria-invalid")).not.toBe("true");
    const banner = $('[data-search-banner=error][role="alert"]')!;
    expect(banner.textContent).toContain("Search could not start");
    const retry = [...banner.querySelectorAll("button")].find((b) => b.textContent?.includes("Retry"));
    await click(retry ?? null);
    expect(calls.searchNow).toEqual([P]);
  });
});

describe("toolbar", () => {
  it("Refresh searches again at once", async () => {
    seed({ query: "q", response: SMALL, status: "done" });
    await render();
    await click(byLabel("Refresh"));
    expect(calls.searchNow).toEqual([P]);
  });

  it("Clear Search Results stops the search and empties the query and the list (4.5)", async () => {
    seed({ query: "q", response: SMALL, status: "done", caseSensitive: true });
    await render();
    await click(byLabel("Clear Search Results"));
    expect(calls.cancel).toEqual([P]);
    expect(state().query).toBe("");
    expect(state().response).toBeNull();
    expect(state().caseSensitive).toBe(true);
    expect(searchInput().value).toBe("");
  });

  it("Collapse All folds every file and turns into Expand All, which unfolds them (4.5)", async () => {
    seed({ query: "q", response: SMALL, status: "done" });
    await render();
    await click(byLabel("Collapse All"));
    expect([...state().collapsed].sort()).toEqual(["src/a.ts", "src/b.ts"]);
    await click(byLabel("Expand All"));
    expect(state().collapsed.size).toBe(0);
    expect(byLabel("Collapse All")).not.toBeNull();
  });

  it("switches between View as Tree and View as List (4.6)", async () => {
    seed({ query: "q", response: SMALL, status: "done" });
    await render();
    await click(byLabel("View as Tree"));
    expect(useSearchStore.getState().viewMode).toBe("tree");
    expect($('[data-kind="folder"]')).not.toBeNull();
    await click(byLabel("View as List"));
    expect(useSearchStore.getState().viewMode).toBe("list");
    expect($('[data-kind="folder"]')).toBeNull();
  });
});

describe("keyboard: results and history", () => {
  it("moves focus from the field into the results on ↓ (6.1)", async () => {
    seed({ query: "useStore", response: SMALL, status: "done" });
    await render();
    await key(searchInput(), { key: "ArrowDown", code: "ArrowDown" });
    expect(document.activeElement?.getAttribute("role")).toBe("tree");
    expect(state().focusedRow).toBe("src/a.ts");
  });

  it("steps through this project's history with Alt+↑ / Alt+↓, and searches each entry (6.3)", async () => {
    useSearchStore.getState().addToHistory(P, "first");
    useSearchStore.getState().addToHistory(P, "second");
    seed({ query: "draft" });
    await render();
    await key(searchInput(), { key: "ArrowUp", code: "ArrowUp", altKey: true });
    expect(searchInput().value).toBe("second");
    await key(searchInput(), { key: "ArrowUp", code: "ArrowUp", altKey: true });
    expect(searchInput().value).toBe("first");
    await key(searchInput(), { key: "ArrowDown", code: "ArrowDown", altKey: true });
    expect(searchInput().value).toBe("second");
    expect(calls.schedule.length).toBe(3);
  });

  it("steps through the history with plain ↑ when the field is empty (6.3)", async () => {
    useSearchStore.getState().addToHistory(P, "older");
    await render();
    await key(searchInput(), { key: "ArrowUp", code: "ArrowUp" });
    expect(searchInput().value).toBe("older");
  });
});

describe("opening and replacing from the list", () => {
  // No `CSS.escape`: the test DOM has no `CSS` global, and a quoted attribute value takes these ids as they are.
  const rowEl = (id: string) => $(`[role=treeitem][data-row-id="${id}"]`);

  it("opens a match with its text selected and closes the drawer (4.2)", async () => {
    seed({ query: "useStore", response: SMALL, status: "done" });
    await render();
    const first = SMALL.results[0]!.matches[0]!;
    await click(rowEl(matchKey("src/a.ts", first)));
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      type: "editor",
      projectId: P,
      metadata: { filePath: "src/a.ts", projectName: P, lineNumber: 3, selection: { line: 3, column: 5, endColumn: 13 } },
    });
    expect(navigated).toBe(1);
  });

  it("replaces one match, removes its row and reports it in the status line (5.4)", async () => {
    seed({ query: "useStore", showReplace: true, replace: "useAppStore", response: SMALL, status: "done" });
    await render();
    const target = SMALL.results[0]!.matches[1]!;
    const id = matchKey("src/a.ts", target);
    const replace = rowEl(id)!.querySelector('button[aria-label="Replace"]');
    await click(replace);
    await settle();
    expect(calls.replace).toEqual([
      { project: P, files: [{ file: "src/a.ts", matches: [{ line: 9, column: 0, text: "useStore", replacement: "useAppStore" }] }] },
    ]);
    expect(rowEl(id)).toBeNull();
    expect(status()).toContain("1 replacement made");
  });

  it("replaces one file's matches from its row (5.4)", async () => {
    seed({ query: "useStore", showReplace: true, replace: "useAppStore", response: SMALL, status: "done" });
    await render();
    await click(rowEl("src/a.ts")!.querySelector('button[aria-label="Replace All in File"]'));
    await settle();
    expect(calls.replace).toHaveLength(1);
    expect(calls.replace[0]!.files.map((f) => [f.file, f.matches.length])).toEqual([["src/a.ts", 2]]);
    expect(rowEl("src/a.ts")).toBeNull();
    expect(rowEl("src/b.ts")).not.toBeNull();
    expect(status()).toContain("2 replacements made");
  });

  it("reports a file changed on disk in the status line and keeps its rows (5.6)", async () => {
    seed({ query: "useStore", showReplace: true, replace: "useAppStore", response: SMALL, status: "done" });
    nextReport = { replaced: 0, files: 0, skipped: [{ file: "src/b.ts", reason: "changed" }], failed: [] };
    await render();
    await click(rowEl("src/b.ts")!.querySelector('button[aria-label="Replace All in File"]'));
    await settle();
    expect(status()).toContain("changed on disk");
    expect(rowEl("src/b.ts")).not.toBeNull();
  });

  it("never sends a file with unsaved changes, and says why (5.8)", async () => {
    setEditorUnsaved("editor-1", P, "src/b.ts", true);
    seed({ query: "useStore", showReplace: true, replace: "useAppStore", response: SMALL, status: "done" });
    await render();
    await click(rowEl("src/b.ts")!.querySelector('button[aria-label="Replace All in File"]'));
    await settle();
    expect(calls.replace).toHaveLength(0);
    expect(status()).toContain("unsaved");
  });

  it("reports a refused replace in the status line", async () => {
    seed({ query: "useStore", showReplace: true, replace: "useAppStore", response: SMALL, status: "done" });
    nextReport = new Error("permission denied");
    await render();
    await click(rowEl("src/b.ts")!.querySelector('button[aria-label="Replace All in File"]'));
    await settle();
    expect(status()).toContain("permission denied");
    expect(rowEl("src/b.ts")).not.toBeNull();
  });

  it("asks before Replace All, from the button and from Ctrl+Alt+Enter (5.5)", async () => {
    seed({ query: "useStore", showReplace: true, replace: "useAppStore", response: SMALL, status: "done" });
    await render();
    await click(byLabel("Replace All"));
    await settle();
    const dialog = document.body.querySelector('[data-testid="replace-all-dialog"]');
    expect(dialog?.textContent?.replace(/\s+/g, " ")).toContain("Replace 3 occurrences across 2 files");
    expect(calls.replace).toHaveLength(0);
    const cancel = [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Cancel");
    await click(cancel ?? null);
    await settle();
    expect(document.body.querySelector('[data-testid="replace-all-dialog"]')).toBeNull();

    await key(searchInput(), { key: "Enter", code: "Enter", ctrlKey: true, altKey: true });
    await settle();
    expect(document.body.querySelector('[data-testid="replace-all-dialog"]')).not.toBeNull();
  });

  it("offers no Replace All while there is nothing to replace", async () => {
    seed({ query: "useStore", showReplace: true, replace: "x", response: response([]), status: "done" });
    await render();
    expect((byLabel("Replace All") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("phone", () => {
  it("gives every option and toolbar button a 44 px target (6.7)", async () => {
    seed({ query: "q", showReplace: true, response: SMALL, status: "done" });
    await render({ mobile: true });
    for (const label of ["Match Case", "Match Whole Word", "Use Regular Expression", "Preserve Case", "Toggle Replace", "Toggle Search Details", "Clear Search Results"]) {
      const el = byLabel(label);
      expect(el, label).not.toBeNull();
      expect(el!.className, label).toContain("min-h-11");
      expect(el!.className, label).toContain("min-w-11");
    }
  });

  it("sizes the field's text at 16 px so iOS does not zoom", async () => {
    await render({ mobile: true });
    expect(searchInput().className).toContain("text-base");
  });
});

it("says nothing about a project when none is open", async () => {
  useProjectStore.setState({ activeProject: null });
  await render();
  expect(searchInput().disabled).toBe(true);
  expect(text()).toContain("Select a project");
  expect(calls.warmUp).toEqual([]);
});
