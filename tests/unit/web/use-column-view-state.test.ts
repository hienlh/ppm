import { describe, expect, test } from "bun:test";
import {
  reduceColumns,
  type ColumnState,
} from "../../../src/web/components/os-explorer/views/use-column-view-state.ts";
import type { FsEntry } from "../../../src/web/lib/fs-api.ts";

function entry(path: string, type: FsEntry["type"] = "file"): FsEntry {
  const name = path.split("/").pop() ?? path;
  return { name, path, type, kind: type, modified: "2026-01-01T00:00:00.000Z" };
}

function fakeAbort(log: string[], path: string): AbortController {
  return {
    signal: { aborted: false } as AbortSignal,
    abort: () => log.push(path),
  } as unknown as AbortController;
}

describe("reduceColumns", () => {
  test("sync from empty state creates a column per path, last one pre-filled", () => {
    const lastEntries = [entry("/a/one.txt")];
    const state = reduceColumns(
      { columns: [] },
      { type: "sync", paths: ["/a"], lastEntries, lastLoading: false, makeAbort: () => new AbortController() },
    );
    expect(state.columns).toHaveLength(1);
    expect(state.columns[0]!.path).toBe("/a");
    expect(state.columns[0]!.entries).toBe(lastEntries);
    expect(state.columns[0]!.loading).toBe(false);
  });

  test("extending the chain keeps existing columns and adds a loading one for the new tail", () => {
    const log: string[] = [];
    const first = reduceColumns(
      { columns: [] },
      {
        type: "sync",
        paths: ["/a"],
        lastEntries: [entry("/a/b", "directory")],
        lastLoading: false,
        makeAbort: () => fakeAbort(log, "/a#1"),
      },
    );
    const second = reduceColumns(first, {
      type: "sync",
      paths: ["/a", "/a/b"],
      lastEntries: [entry("/a/b/c.txt")],
      lastLoading: false,
      makeAbort: () => fakeAbort(log, "/a/b#1"),
    });

    expect(log).toHaveLength(0); // nothing truncated yet, nothing aborted
    expect(second.columns).toHaveLength(2);
    expect(second.columns[0]!.path).toBe("/a");
    expect(second.columns[1]!.path).toBe("/a/b");
    expect(second.columns[1]!.entries).toEqual([entry("/a/b/c.txt")]);
  });

  test("selecting a divergent branch truncates trailing columns and aborts their fetch", () => {
    const log: string[] = [];
    let state = reduceColumns(
      { columns: [] },
      {
        type: "sync",
        paths: ["/a"],
        lastEntries: [],
        lastLoading: false,
        makeAbort: () => fakeAbort(log, "col:/a"),
      },
    );
    state = reduceColumns(state, {
      type: "sync",
      paths: ["/a", "/a/b"],
      lastEntries: [],
      lastLoading: false,
      makeAbort: () => fakeAbort(log, "col:/a/b"),
    });
    state = reduceColumns(state, {
      type: "sync",
      paths: ["/a", "/a/b", "/a/b/c"],
      lastEntries: [entry("/a/b/c/d.txt")],
      lastLoading: false,
      makeAbort: () => fakeAbort(log, "col:/a/b/c"),
    });
    expect(state.columns.map((c) => c.path)).toEqual(["/a", "/a/b", "/a/b/c"]);
    log.length = 0;

    // User picks a different child of "/a" ("/a/x" instead of "/a/b") — everything from
    // index 1 onward must be replaced, and each replaced column's own fetch aborted.
    const next = reduceColumns(state, {
      type: "sync",
      paths: ["/a", "/a/x"],
      lastEntries: [entry("/a/x/e.txt")],
      lastLoading: false,
      makeAbort: () => fakeAbort(log, "col:/a/x"),
    });

    expect(next.columns.map((c) => c.path)).toEqual(["/a", "/a/x"]);
    expect(next.columns[0]!.path).toBe("/a"); // unchanged ancestor kept, not aborted
    expect(log).toEqual(["col:/a/b", "col:/a/b/c"]);
  });

  test("loaded/error only patch the matching column by path", () => {
    const state: { columns: ColumnState[] } = {
      columns: [
        { path: "/a", entries: [], loading: true, error: null, abort: new AbortController() },
        { path: "/a/b", entries: [], loading: true, error: null, abort: new AbortController() },
      ],
    };
    const loaded = reduceColumns(state, { type: "loaded", path: "/a", entries: [entry("/a/x.txt")] });
    expect(loaded.columns[0]!.loading).toBe(false);
    expect(loaded.columns[0]!.entries).toEqual([entry("/a/x.txt")]);
    expect(loaded.columns[1]!.loading).toBe(true); // untouched

    const errored = reduceColumns(loaded, { type: "error", path: "/a/b", message: "denied" });
    expect(errored.columns[1]!.loading).toBe(false);
    expect(errored.columns[1]!.error).toBe("denied");
    expect(errored.columns[0]!.error).toBeNull(); // untouched
  });
});
