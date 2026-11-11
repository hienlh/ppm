/**
 * The search panel's state lives in a store, one entry per project, so switching sidebar panels,
 * closing the mobile drawer or switching projects never loses a query or its results (6.5, 6.6).
 * View as Tree/List is remembered across reloads (4.6) and each project keeps its last 20
 * queries in localStorage (6.3).
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { createElement } from "react";
import { mount } from "../../../helpers/react-dom.tsx";
import {
  useSearchStore,
  getSearchState,
  defaultSearchState,
  readStoredViewMode,
  readStoredHistory,
  HISTORY_LIMIT,
  VIEW_MODE_KEY,
  historyKey,
} from "../../../../src/web/stores/search-store.ts";
import type { SearchResponse } from "../../../../src/services/content-search/search-options.ts";

const response: SearchResponse = {
  results: [{ file: "a.ts", matches: [{ line: 1, column: 0, length: 3, before: "", cutBefore: false, text: "foo", after: "" }] }],
  total: 1,
  files: 1,
  limitHit: false,
  engine: "rg",
};

beforeEach(() => {
  localStorage.clear();
  useSearchStore.setState({ projects: {}, history: {}, viewMode: "list" });
});

describe("per-project state", () => {
  it("starts a project with the defaults: nothing typed, ignore files on, idle", () => {
    const s = getSearchState("ppm");
    expect(s.query).toBe("");
    expect(s.useIgnore).toBe(true);
    expect(s.caseSensitive).toBe(false);
    expect(s.wholeWord).toBe(false);
    expect(s.regex).toBe(false);
    expect(s.include).toBe("");
    expect(s.exclude).toBe("");
    expect(s.replace).toBe("");
    expect(s.response).toBeNull();
    expect(s.status).toBe("idle");
    expect(s.dismissed.size).toBe(0);
    expect(s.collapsed.size).toBe(0);
    expect(defaultSearchState().useIgnore).toBe(true);
  });

  it("keeps each project's query, options and results apart", () => {
    const { update } = useSearchStore.getState();
    update("ppm", { query: "foo", regex: true, include: "*.ts", response, status: "done" });
    update("other", { query: "bar", useIgnore: false });

    expect(getSearchState("ppm")).toMatchObject({ query: "foo", regex: true, include: "*.ts", status: "done" });
    expect(getSearchState("ppm").response).toBe(response);
    expect(getSearchState("other")).toMatchObject({ query: "bar", useIgnore: false, regex: false, response: null });
  });

  it("keeps the state after the component showing it unmounts, and shows it again on remount", async () => {
    const seen: string[] = [];
    function Probe({ project }: { project: string }) {
      const query = useSearchStore((s) => s.projects[project]?.query ?? "");
      seen.push(query);
      return null;
    }

    const first = await mount(createElement(Probe, { project: "ppm" }));
    useSearchStore.getState().update("ppm", { query: "kept", replace: "new", showReplace: true, response });
    await first.unmount();

    await mount(createElement(Probe, { project: "ppm" }));
    expect(seen.at(-1)).toBe("kept");
    expect(getSearchState("ppm")).toMatchObject({ replace: "new", showReplace: true });
    expect(getSearchState("ppm").response).toBe(response);
  });

  it("Clear empties the query and the list but keeps the options and filters", () => {
    const { update, clear } = useSearchStore.getState();
    update("ppm", { query: "foo", caseSensitive: true, exclude: "dist", response, status: "done", dismissed: new Set(["a.ts:1:0"]) });
    clear("ppm");
    const s = getSearchState("ppm");
    expect(s.query).toBe("");
    expect(s.response).toBeNull();
    expect(s.status).toBe("idle");
    expect(s.dismissed.size).toBe(0);
    expect(s.caseSensitive).toBe(true);
    expect(s.exclude).toBe("dist");
  });
});

describe("View as Tree / List", () => {
  it("defaults to the list and remembers the choice in localStorage", () => {
    expect(readStoredViewMode()).toBe("list");
    useSearchStore.getState().setViewMode("tree");
    expect(useSearchStore.getState().viewMode).toBe("tree");
    expect(localStorage.getItem(VIEW_MODE_KEY)).toBe("tree");
    expect(readStoredViewMode()).toBe("tree");
  });

  it("reads junk in the key as the list", () => {
    localStorage.setItem(VIEW_MODE_KEY, "grid");
    expect(readStoredViewMode()).toBe("list");
  });
});

describe("query history", () => {
  it("keeps the last 20 queries of a project, newest first, without repeats, in localStorage", () => {
    const { addToHistory } = useSearchStore.getState();
    for (let i = 0; i < 25; i++) addToHistory("ppm", `q${i}`);
    addToHistory("ppm", "q10");

    const list = useSearchStore.getState().historyOf("ppm");
    expect(HISTORY_LIMIT).toBe(20);
    expect(list.length).toBe(20);
    expect(list[0]).toBe("q10");
    expect(list[1]).toBe("q24");
    expect(list.filter((q) => q === "q10").length).toBe(1);
    expect(historyKey("ppm")).toBe("ppm.search.history.ppm");
    expect(JSON.parse(localStorage.getItem(historyKey("ppm"))!)).toEqual(list);
    expect(readStoredHistory("ppm")).toEqual(list);
  });

  it("ignores an empty query and keeps each project's history apart", () => {
    const { addToHistory, historyOf } = useSearchStore.getState();
    addToHistory("ppm", "  ");
    addToHistory("ppm", "alpha");
    addToHistory("other", "beta");
    expect(useSearchStore.getState().historyOf("ppm")).toEqual(["alpha"]);
    expect(historyOf("other")).toEqual(["beta"]);
  });

  it("loads a project's history saved by an earlier page", () => {
    localStorage.setItem(historyKey("ppm"), JSON.stringify(["old", "older"]));
    expect(useSearchStore.getState().historyOf("ppm")).toEqual(["old", "older"]);
  });

  it("steps older and newer through the history, past the newest back to an empty field", () => {
    const { addToHistory, stepHistory, update } = useSearchStore.getState();
    addToHistory("ppm", "one");
    addToHistory("ppm", "two");
    addToHistory("ppm", "three");
    update("ppm", { query: "three" });

    // The field already shows the newest entry, so the first step goes past it.
    stepHistory("ppm", "older");
    expect(getSearchState("ppm").query).toBe("two");
    stepHistory("ppm", "older");
    expect(getSearchState("ppm").query).toBe("one");
    stepHistory("ppm", "older");
    expect(getSearchState("ppm").query).toBe("one");

    stepHistory("ppm", "newer");
    expect(getSearchState("ppm").query).toBe("two");
    stepHistory("ppm", "newer");
    expect(getSearchState("ppm").query).toBe("three");
    stepHistory("ppm", "newer");
    expect(getSearchState("ppm").query).toBe("");
  });

  it("starts from the newest entry when the field holds something else, and typing restarts the walk", () => {
    const { addToHistory, stepHistory, update } = useSearchStore.getState();
    addToHistory("ppm", "one");
    addToHistory("ppm", "two");

    stepHistory("ppm", "older");
    expect(getSearchState("ppm").query).toBe("two");
    stepHistory("ppm", "older");
    expect(getSearchState("ppm").query).toBe("one");

    update("ppm", { query: "typed" });
    stepHistory("ppm", "older");
    expect(getSearchState("ppm").query).toBe("two");
  });
});
