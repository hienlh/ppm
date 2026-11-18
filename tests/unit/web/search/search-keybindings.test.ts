/**
 * Global search keys (6.2, 6.4):
 *
 * - The search shortcut opens the Search panel with the focused editor's one-line selection as
 *   the query. It has to fire while the editor holds focus — Monaco types into a `<textarea>`,
 *   which is exactly where the selection is made.
 * - F4 / Shift+F4 open the next / previous match of the active project's search, wrapping at
 *   the ends, and selecting the matched text in the editor. With no results the key is left
 *   alone.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { installDom, installGlobal, uninstallDom, mount } from "../../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
installGlobal("fetch", async () => new Response(JSON.stringify({ ok: true, data: { results: [], total: 0, files: 0, limitHit: false, engine: "rg" } })));

const { useGlobalKeybindings } = await import("../../../../src/web/hooks/use-global-keybindings");
const { useSettingsStore } = await import("../../../../src/web/stores/settings-store");
const { useProjectStore } = await import("../../../../src/web/stores/project-store");
const { useTabStore } = await import("../../../../src/web/stores/tab-store");
const { useSearchStore, getSearchState, defaultSearchState } = await import("../../../../src/web/stores/search-store");
const { KEY_ACTIONS, parseCombo, eventMatchesCombo } = await import("../../../../src/web/stores/keybindings-store");
const { setFocusedEditor, clearEditor } = await import("../../../../src/web/lib/open-editors-registry");
const { searchClient } = await import("../../../../src/web/lib/search/search-client");

type Range = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };

const PROJECT = { name: "alpha", path: "/p/alpha" };

function Probe() {
  useGlobalKeybindings();
  return null;
}

/** Dispatches a keydown on `target` and answers whether a handler claimed it. */
function press(target: EventTarget, init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

/** A stand-in for Monaco's own textarea, focused while the user selects. */
function editorTextarea(): HTMLTextAreaElement {
  const field = document.createElement("textarea");
  document.body.appendChild(field);
  return field;
}

/** Registers a focused editor whose selection covers `range` of `text`'s lines. */
function focusEditor(projectName: string, lines: string[], range: Range) {
  const getValueInRange = (r: Range) => {
    if (r.startLineNumber === r.endLineNumber) {
      return lines[r.startLineNumber - 1]!.slice(r.startColumn - 1, r.endColumn - 1);
    }
    const first = lines[r.startLineNumber - 1]!.slice(r.startColumn - 1);
    const middle = lines.slice(r.startLineNumber, r.endLineNumber - 1);
    const last = lines[r.endLineNumber - 1]!.slice(0, r.endColumn - 1);
    return [first, ...middle, last].join("\n");
  };
  setFocusedEditor("ed-1", {
    projectName,
    filePath: "src/a.ts",
    editor: { getSelection: () => range, getModel: () => ({ getValueInRange }) },
  });
}

const FIND_COMBO = parseCombo(KEY_ACTIONS.find((a) => a.id === "open-search")!.defaultKey);
const findShortcut = { key: FIND_COMBO.key.toUpperCase(), ctrlKey: FIND_COMBO.ctrl, metaKey: FIND_COMBO.meta, altKey: FIND_COMBO.alt, shiftKey: FIND_COMBO.shift };

let opened: Array<{ type: string; metadata?: Record<string, unknown>; projectId: string | null }> = [];
const originalOpenTab = useTabStore.getState().openTab;
const originalUpdateTab = useTabStore.getState().updateTab;

beforeEach(() => {
  opened = [];
  useSettingsStore.setState({ minimalMode: false, sidebarCollapsed: false, sidebarActiveTab: "explorer" as never });
  useProjectStore.setState({ projects: [PROJECT] as never, activeProject: PROJECT as never });
  useSearchStore.setState({ projects: {}, history: {}, viewMode: "list" });
  useTabStore.setState({
    openTab: (def: never) => { opened.push(def); return "tab-1"; },
    updateTab: () => {},
  } as never);
});

afterEach(() => {
  clearEditor("ed-1");
  searchClient.cancel(PROJECT.name);
  useTabStore.setState({ openTab: originalOpenTab, updateTab: originalUpdateTab } as never);
  for (const el of [...document.querySelectorAll("textarea")]) el.remove();
});

describe("the F4 / Shift+F4 actions", () => {
  test("are listed with VS Code's keys, and claim no other action's combo", () => {
    expect(KEY_ACTIONS.find((a) => a.id === "search-next-match")?.defaultKey).toBe("F4");
    expect(KEY_ACTIONS.find((a) => a.id === "search-prev-match")?.defaultKey).toBe("Shift+F4");
    const f4 = { key: "F4", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false } as KeyboardEvent;
    const shiftF4 = { ...f4, shiftKey: true } as KeyboardEvent;
    const claimingF4 = KEY_ACTIONS.filter((a) => a.defaultKey && eventMatchesCombo(f4, parseCombo(a.defaultKey))).map((a) => a.id);
    const claimingShiftF4 = KEY_ACTIONS.filter((a) => a.defaultKey && eventMatchesCombo(shiftF4, parseCombo(a.defaultKey))).map((a) => a.id);
    expect(claimingF4).toEqual(["search-next-match"]);
    expect(claimingShiftF4).toEqual(["search-prev-match"]);
  });
});

describe("the search shortcut seeds the query with the editor's selection (6.4)", () => {
  test("a one-line selection becomes the query, pressed inside the editor", async () => {
    focusEditor(PROJECT.name, ["const needle = 1;", "next line"], { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 13 });
    const view = await mount(createElement(Probe));
    try {
      expect(press(editorTextarea(), findShortcut)).toBe(true);
      expect(useSettingsStore.getState().sidebarActiveTab).toBe("search");
      expect(getSearchState(PROJECT.name).query).toBe("needle");
    } finally {
      await view.unmount();
    }
  });

  test("a selection over several lines leaves the query as it was", async () => {
    useSearchStore.getState().update(PROJECT.name, { query: "before" });
    focusEditor(PROJECT.name, ["const needle = 1;", "next line"], { startLineNumber: 1, startColumn: 7, endLineNumber: 2, endColumn: 5 });
    const view = await mount(createElement(Probe));
    try {
      expect(press(editorTextarea(), findShortcut)).toBe(true);
      expect(useSettingsStore.getState().sidebarActiveTab).toBe("search");
      expect(getSearchState(PROJECT.name).query).toBe("before");
    } finally {
      await view.unmount();
    }
  });

  test("an editor of another project does not seed this project's search", async () => {
    focusEditor("beta", ["const needle = 1;"], { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 13 });
    const view = await mount(createElement(Probe));
    try {
      expect(press(document.body, findShortcut)).toBe(true);
      expect(getSearchState(PROJECT.name).query).toBe("");
      expect(getSearchState("beta").query).toBe("");
    } finally {
      await view.unmount();
    }
  });

  test("no selection: the panel opens and the query is kept", async () => {
    useSearchStore.getState().update(PROJECT.name, { query: "kept" });
    const view = await mount(createElement(Probe));
    try {
      expect(press(document.body, findShortcut)).toBe(true);
      expect(useSettingsStore.getState().sidebarActiveTab).toBe("search");
      expect(getSearchState(PROJECT.name).query).toBe("kept");
    } finally {
      await view.unmount();
    }
  });
});

function match(line: number, column: number, text: string) {
  return { line, column, length: text.length, before: "", cutBefore: false, text, after: "" };
}

function seedResults() {
  useSearchStore.getState().update(PROJECT.name, {
    ...defaultSearchState(),
    query: "foo",
    status: "done",
    response: {
      results: [
        { file: "src/a.ts", matches: [match(3, 4, "foo"), match(9, 0, "foo")] },
        { file: "src/b.ts", matches: [match(1, 10, "foo")] },
      ],
      total: 3,
      files: 2,
      limitHit: false,
      engine: "rg",
    },
  });
}

describe("F4 / Shift+F4 open the next / previous match (6.2)", () => {
  test("F4 walks forward, selecting each match, and wraps to the first", async () => {
    seedResults();
    const view = await mount(createElement(Probe));
    try {
      for (let i = 0; i < 4; i++) expect(press(document.body, { key: "F4" })).toBe(true);
      expect(opened.map((t) => [t.type, t.metadata?.filePath, t.metadata?.projectName, t.metadata?.selection])).toEqual([
        ["editor", "src/a.ts", PROJECT.name, { line: 3, column: 5, endColumn: 8 }],
        ["editor", "src/a.ts", PROJECT.name, { line: 9, column: 1, endColumn: 4 }],
        ["editor", "src/b.ts", PROJECT.name, { line: 1, column: 11, endColumn: 14 }],
        ["editor", "src/a.ts", PROJECT.name, { line: 3, column: 5, endColumn: 8 }],
      ]);
      expect(opened.every((t) => t.projectId === PROJECT.name)).toBe(true);
      expect(getSearchState(PROJECT.name).focusedRow).toBe("src/a.ts:3:4");
    } finally {
      await view.unmount();
    }
  });

  test("Shift+F4 with nothing focused opens the last match, then steps back", async () => {
    seedResults();
    const view = await mount(createElement(Probe));
    try {
      expect(press(document.body, { key: "F4", shiftKey: true })).toBe(true);
      expect(press(document.body, { key: "F4", shiftKey: true })).toBe(true);
      expect(opened.map((t) => [t.metadata?.filePath, (t.metadata?.selection as { line: number }).line])).toEqual([
        ["src/b.ts", 1],
        ["src/a.ts", 9],
      ]);
      expect(getSearchState(PROJECT.name).focusedRow).toBe("src/a.ts:9:0");
    } finally {
      await view.unmount();
    }
  });

  test("works while the editor holds focus, and skips dismissed matches", async () => {
    seedResults();
    useSearchStore.getState().update(PROJECT.name, { dismissed: new Set(["src/a.ts:9:0"]), focusedRow: "src/a.ts:3:4" });
    const view = await mount(createElement(Probe));
    try {
      expect(press(editorTextarea(), { key: "F4" })).toBe(true);
      expect(opened.map((t) => t.metadata?.filePath)).toEqual(["src/b.ts"]);
    } finally {
      await view.unmount();
    }
  });

  test("with no results the key is left alone", async () => {
    const view = await mount(createElement(Probe));
    try {
      expect(press(document.body, { key: "F4" })).toBe(false);
      expect(press(document.body, { key: "F4", shiftKey: true })).toBe(false);
      expect(opened).toEqual([]);
    } finally {
      await view.unmount();
    }
  });
});
