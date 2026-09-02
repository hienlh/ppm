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

/** Simulates what the hook's effect does with `state.staleControllers` after a dispatch. */
function abortAll(controllers: AbortController[]): void {
  for (const c of controllers) c.abort();
}

describe("reduceColumns", () => {
  test("sync from empty state creates a column per path, last one pre-filled", () => {
    const lastEntries = [entry("/a/one.txt")];
    const state = reduceColumns(
      { columns: [], staleControllers: [] },
      { type: "sync", paths: ["/a"], lastEntries, lastLoading: false, makeAbort: () => new AbortController() },
    );
    expect(state.columns).toHaveLength(1);
    expect(state.columns[0]!.path).toBe("/a");
    expect(state.columns[0]!.entries).toBe(lastEntries);
    expect(state.columns[0]!.loading).toBe(false);
    expect(state.staleControllers).toHaveLength(0);
  });

  test("extending the chain keeps existing columns and adds a loading one for the new tail", () => {
    const log: string[] = [];
    const first = reduceColumns(
      { columns: [], staleControllers: [] },
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

    expect(second.staleControllers).toHaveLength(0); // nothing truncated yet, nothing stale
    abortAll(second.staleControllers);
    expect(log).toHaveLength(0);
    expect(second.columns).toHaveLength(2);
    expect(second.columns[0]!.path).toBe("/a");
    expect(second.columns[1]!.path).toBe("/a/b");
    expect(second.columns[1]!.entries).toEqual([entry("/a/b/c.txt")]);
  });

  test("selecting a divergent branch truncates trailing columns and reports their fetch as stale", () => {
    const log: string[] = [];
    let state = reduceColumns(
      { columns: [], staleControllers: [] },
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
    // index 1 onward must be replaced, and each replaced column's fetch reported stale.
    const next = reduceColumns(state, {
      type: "sync",
      paths: ["/a", "/a/x"],
      lastEntries: [entry("/a/x/e.txt")],
      lastLoading: false,
      makeAbort: () => fakeAbort(log, "col:/a/x"),
    });

    expect(next.columns.map((c) => c.path)).toEqual(["/a", "/a/x"]);
    expect(next.columns[0]!.path).toBe("/a"); // unchanged ancestor kept, not reported stale
    // The reducer itself must not have called .abort() — it only reports what to abort.
    expect(log).toHaveLength(0);
    abortAll(next.staleControllers);
    expect(log).toEqual(["col:/a/b", "col:/a/b/c"]);
  });

  test("re-entering a path whose fetch was aborted gets a fresh controller, not stuck on the old one", () => {
    // Drill /a -> /a/b, jump to sibling /a/x (aborts /a/b's controller), then go back to
    // /a/b before the old request would have settled. H3: a guard keyed by *path* would
    // see "/a/b" as already fetching (the stale attempt's cleanup hasn't run yet) and skip
    // starting a new one, leaving the new column stuck on "Loading…" forever. The reducer's
    // job is only to guarantee the new column gets a controller distinct from the old one
    // — the hook is responsible for keying its in-flight guard by that identity, not by path.
    const log: string[] = [];
    let state = reduceColumns(
      { columns: [], staleControllers: [] },
      { type: "sync", paths: ["/a"], lastEntries: [], lastLoading: false, makeAbort: () => new AbortController() },
    );
    const firstAttemptAbort = new AbortController();
    state = reduceColumns(state, {
      type: "sync",
      paths: ["/a", "/a/b"],
      lastEntries: [],
      lastLoading: false,
      makeAbort: () => firstAttemptAbort,
    });
    expect(state.columns[1]!.abort).toBe(firstAttemptAbort);

    state = reduceColumns(state, {
      type: "sync",
      paths: ["/a", "/a/x"],
      lastEntries: [],
      lastLoading: false,
      makeAbort: () => fakeAbort(log, "col:/a/x"),
    });
    expect(state.staleControllers).toContain(firstAttemptAbort); // the hook will abort it

    const secondAttemptAbort = new AbortController();
    state = reduceColumns(state, {
      type: "sync",
      paths: ["/a", "/a/b"],
      lastEntries: [entry("/a/b/f.txt")],
      lastLoading: true,
      makeAbort: () => secondAttemptAbort,
    });

    expect(state.columns[1]!.path).toBe("/a/b");
    expect(state.columns[1]!.abort).toBe(secondAttemptAbort);
    expect(state.columns[1]!.abort).not.toBe(firstAttemptAbort);
    expect(state.columns[1]!.loading).toBe(true);
  });

  test("loaded/error only patch the matching column by path", () => {
    const state: { columns: ColumnState[]; staleControllers: AbortController[] } = {
      columns: [
        { path: "/a", entries: [], loading: true, error: null, abort: new AbortController() },
        { path: "/a/b", entries: [], loading: true, error: null, abort: new AbortController() },
      ],
      staleControllers: [],
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
