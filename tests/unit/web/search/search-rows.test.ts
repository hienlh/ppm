/**
 * The search panel's result rows, as a pure model: list and tree rows, counts that leave
 * dismissed matches out (1.6, 4.4), Collapse/Expand All (4.5), View as Tree/List (4.6),
 * F4 / Shift+F4 with wrap (6.2), arrow-key focus moves (6.1), the ReplaceRequest for one
 * match / one file / everything left (5.4, 5.5) and the filters-active dot (2.6).
 */
import { describe, it, expect } from "bun:test";
import type { SearchMatch, SearchResponse } from "../../../../src/services/content-search/search-options.ts";
import {
  matchKey,
  countResults,
  resultSummary,
  buildRows,
  allCollapsibleIds,
  nextMatch,
  moveFocus,
  buildReplaceFiles,
  filtersActive,
  type SearchRow,
} from "../../../../src/web/lib/search/search-rows.ts";

function m(line: number, column: number, text = "foo", replacement?: string): SearchMatch {
  return {
    line,
    column,
    length: text.length,
    before: "x ",
    cutBefore: false,
    text,
    after: " y",
    ...(replacement !== undefined ? { replacement } : {}),
  };
}

function response(results: SearchResponse["results"]): SearchResponse {
  const total = results.reduce((n, r) => n + r.matches.length, 0);
  return { results, total, files: results.length, limitHit: false, engine: "rg" };
}

// Sorted by path, as the server sends it.
const RESP = response([
  { file: "README.md", matches: [m(1, 0)] },
  { file: "src/services/agent/a.ts", matches: [m(2, 4), m(9, 1)] },
  { file: "src/services/file-chunks.ts", matches: [m(3, 0), m(3, 10), m(7, 2)] },
  { file: "tests/unit/x.test.ts", matches: [m(5, 5)] },
]);

const NONE = new Set<string>();

function ids(rows: SearchRow[]) {
  return rows.map((r) => `${r.kind}:${r.id}@${r.depth}`);
}

describe("matchKey", () => {
  it("is file:line:column", () => {
    expect(matchKey("src/a.ts", m(12, 3))).toBe("src/a.ts:12:3");
  });
});

describe("countResults / resultSummary", () => {
  it("counts every match and file", () => {
    expect(countResults(RESP, NONE)).toEqual({ total: 7, files: 4 });
  });

  it("leaves dismissed matches out, and a file whose matches are all dismissed", () => {
    const dismissed = new Set(["README.md:1:0", "src/services/file-chunks.ts:3:10"]);
    expect(countResults(RESP, dismissed)).toEqual({ total: 5, files: 3 });
  });

  it("leaves a dismissed file out by its path", () => {
    expect(countResults(RESP, new Set(["src/services/file-chunks.ts"]))).toEqual({ total: 4, files: 3 });
  });

  it("says N results in M files, singular when one", () => {
    expect(resultSummary({ total: 7, files: 4 })).toBe("7 results in 4 files");
    expect(resultSummary({ total: 1, files: 1 })).toBe("1 result in 1 file");
    expect(resultSummary({ total: 0, files: 0 })).toBe("No results found");
  });
});

describe("buildRows — list", () => {
  it("lists files flat with their folder, then their matches", () => {
    const rows = buildRows(RESP, { viewMode: "list", dismissed: NONE, collapsed: NONE });
    expect(ids(rows)).toEqual([
      "file:README.md@0",
      "match:README.md:1:0@1",
      "file:src/services/agent/a.ts@0",
      "match:src/services/agent/a.ts:2:4@1",
      "match:src/services/agent/a.ts:9:1@1",
      "file:src/services/file-chunks.ts@0",
      "match:src/services/file-chunks.ts:3:0@1",
      "match:src/services/file-chunks.ts:3:10@1",
      "match:src/services/file-chunks.ts:7:2@1",
      "file:tests/unit/x.test.ts@0",
      "match:tests/unit/x.test.ts:5:5@1",
    ]);
    const file = rows[2];
    expect(file.kind).toBe("file");
    if (file.kind !== "file") throw new Error("unreachable");
    expect(file.name).toBe("a.ts");
    expect(file.dir).toBe("src/services/agent");
    expect(file.count).toBe(2);
    expect(file.collapsed).toBe(false);
    const root = rows[0];
    if (root.kind !== "file") throw new Error("unreachable");
    expect(root.dir).toBe("");
  });

  it("keeps the match itself on its row", () => {
    const rows = buildRows(RESP, { viewMode: "list", dismissed: NONE, collapsed: NONE });
    const row = rows[1];
    if (row.kind !== "match") throw new Error("expected a match row");
    expect(row.file).toBe("README.md");
    expect(row.match).toBe(RESP.results[0].matches[0]);
  });

  it("hides the matches of a collapsed file but keeps its row", () => {
    const rows = buildRows(RESP, {
      viewMode: "list",
      dismissed: NONE,
      collapsed: new Set(["src/services/file-chunks.ts"]),
    });
    expect(ids(rows).filter((id) => id.includes("file-chunks"))).toEqual(["file:src/services/file-chunks.ts@0"]);
    const file = rows.find((r) => r.id === "src/services/file-chunks.ts");
    expect(file?.kind === "file" && file.collapsed).toBe(true);
    expect(file?.kind === "file" && file.count).toBe(3);
  });

  it("drops dismissed matches and files emptied by dismissal, and counts without them", () => {
    const rows = buildRows(RESP, {
      viewMode: "list",
      dismissed: new Set(["README.md:1:0", "src/services/file-chunks.ts:3:10", "tests/unit/x.test.ts"]),
      collapsed: NONE,
    });
    expect(ids(rows)).toEqual([
      "file:src/services/agent/a.ts@0",
      "match:src/services/agent/a.ts:2:4@1",
      "match:src/services/agent/a.ts:9:1@1",
      "file:src/services/file-chunks.ts@0",
      "match:src/services/file-chunks.ts:3:0@1",
      "match:src/services/file-chunks.ts:7:2@1",
    ]);
    const file = rows[3];
    expect(file.kind === "file" && file.count).toBe(2);
  });

  it("is empty for no response", () => {
    expect(buildRows(null, { viewMode: "list", dismissed: NONE, collapsed: NONE })).toEqual([]);
  });
});

describe("buildRows — tree", () => {
  it("groups under folders (folders first), compacting single-folder chains", () => {
    const rows = buildRows(RESP, { viewMode: "tree", dismissed: NONE, collapsed: NONE });
    expect(ids(rows)).toEqual([
      "folder:src/services@0",
      "folder:src/services/agent@1",
      "file:src/services/agent/a.ts@2",
      "match:src/services/agent/a.ts:2:4@3",
      "match:src/services/agent/a.ts:9:1@3",
      "file:src/services/file-chunks.ts@1",
      "match:src/services/file-chunks.ts:3:0@2",
      "match:src/services/file-chunks.ts:3:10@2",
      "match:src/services/file-chunks.ts:7:2@2",
      "folder:tests/unit@0",
      "file:tests/unit/x.test.ts@1",
      "match:tests/unit/x.test.ts:5:5@2",
      "file:README.md@0",
      "match:README.md:1:0@1",
    ]);
  });

  it("names a compacted folder by its whole chain and a nested one by what is left", () => {
    const rows = buildRows(RESP, { viewMode: "tree", dismissed: NONE, collapsed: NONE });
    const top = rows[0];
    const nested = rows[1];
    if (top.kind !== "folder" || nested.kind !== "folder") throw new Error("expected folders");
    expect(top.name).toBe("src/services");
    expect(top.count).toBe(5);
    expect(nested.name).toBe("agent");
    expect(nested.count).toBe(2);
  });

  it("hides everything under a collapsed folder", () => {
    const rows = buildRows(RESP, { viewMode: "tree", dismissed: NONE, collapsed: new Set(["src/services"]) });
    expect(ids(rows)).toEqual([
      "folder:src/services@0",
      "folder:tests/unit@0",
      "file:tests/unit/x.test.ts@1",
      "match:tests/unit/x.test.ts:5:5@2",
      "file:README.md@0",
      "match:README.md:1:0@1",
    ]);
    expect(rows[0].kind === "folder" && rows[0].collapsed).toBe(true);
  });

  it("drops a folder whose matches are all dismissed and recounts its parents", () => {
    const rows = buildRows(RESP, {
      viewMode: "tree",
      dismissed: new Set(["src/services/agent/a.ts"]),
      collapsed: NONE,
    });
    expect(ids(rows).slice(0, 2)).toEqual(["folder:src/services@0", "file:src/services/file-chunks.ts@1"]);
    expect(rows[0].kind === "folder" && rows[0].count).toBe(3);
  });
});

describe("allCollapsibleIds (Collapse All)", () => {
  it("lists every file in list view", () => {
    expect([...allCollapsibleIds(RESP, "list", NONE)].sort()).toEqual([
      "README.md",
      "src/services/agent/a.ts",
      "src/services/file-chunks.ts",
      "tests/unit/x.test.ts",
    ]);
  });

  it("lists every folder and file in tree view, so only the top level shows", () => {
    const all = allCollapsibleIds(RESP, "tree", NONE);
    expect([...all].sort()).toEqual([
      "README.md",
      "src/services",
      "src/services/agent",
      "src/services/agent/a.ts",
      "src/services/file-chunks.ts",
      "tests/unit",
      "tests/unit/x.test.ts",
    ]);
    const rows = buildRows(RESP, { viewMode: "tree", dismissed: NONE, collapsed: all });
    expect(ids(rows)).toEqual(["folder:src/services@0", "folder:tests/unit@0", "file:README.md@0"]);
  });
});

describe("nextMatch (F4 / Shift+F4)", () => {
  const opts = { viewMode: "list" as const, dismissed: NONE };

  it("starts at the first match, or the last going back", () => {
    expect(nextMatch(RESP, opts, null, 1)?.key).toBe("README.md:1:0");
    expect(nextMatch(RESP, opts, null, -1)?.key).toBe("tests/unit/x.test.ts:5:5");
  });

  it("steps across files and wraps at both ends", () => {
    expect(nextMatch(RESP, opts, "README.md:1:0", 1)?.key).toBe("src/services/agent/a.ts:2:4");
    expect(nextMatch(RESP, opts, "src/services/agent/a.ts:2:4", -1)?.key).toBe("README.md:1:0");
    expect(nextMatch(RESP, opts, "tests/unit/x.test.ts:5:5", 1)?.key).toBe("README.md:1:0");
    expect(nextMatch(RESP, opts, "README.md:1:0", -1)?.key).toBe("tests/unit/x.test.ts:5:5");
  });

  it("returns the file and match to open", () => {
    const next = nextMatch(RESP, opts, "src/services/agent/a.ts:9:1", 1);
    expect(next?.file).toBe("src/services/file-chunks.ts");
    expect(next?.match).toBe(RESP.results[2].matches[0]);
  });

  it("follows the tree's order and goes into collapsed files", () => {
    const tree = { viewMode: "tree" as const, dismissed: NONE };
    expect(nextMatch(RESP, tree, null, 1)?.key).toBe("src/services/agent/a.ts:2:4");
    expect(nextMatch(RESP, tree, "tests/unit/x.test.ts:5:5", 1)?.key).toBe("README.md:1:0");
    expect(nextMatch(RESP, tree, "README.md:1:0", 1)?.key).toBe("src/services/agent/a.ts:2:4");
  });

  it("skips dismissed matches", () => {
    const dismissed = new Set(["src/services/agent/a.ts"]);
    expect(nextMatch(RESP, { viewMode: "list", dismissed }, "README.md:1:0", 1)?.key).toBe(
      "src/services/file-chunks.ts:3:0",
    );
  });

  it("is null with nothing left", () => {
    expect(nextMatch(null, opts, null, 1)).toBeNull();
    expect(nextMatch(response([]), opts, null, 1)).toBeNull();
  });
});

describe("moveFocus (↑ ↓ ← → Enter)", () => {
  const list = buildRows(RESP, { viewMode: "list", dismissed: NONE, collapsed: NONE });
  const tree = buildRows(RESP, { viewMode: "tree", dismissed: NONE, collapsed: NONE });

  it("Down with nothing focused goes to the first row", () => {
    expect(moveFocus(list, null, "down").focus).toBe("README.md");
  });

  it("Up/Down move one row and stop at the ends", () => {
    expect(moveFocus(list, "README.md", "down").focus).toBe("README.md:1:0");
    expect(moveFocus(list, "README.md:1:0", "up").focus).toBe("README.md");
    expect(moveFocus(list, "README.md", "up").focus).toBe("README.md");
    expect(moveFocus(list, "tests/unit/x.test.ts:5:5", "down").focus).toBe("tests/unit/x.test.ts:5:5");
  });

  it("Left on an expanded file collapses it; Right on a collapsed one expands it", () => {
    expect(moveFocus(list, "README.md", "left")).toEqual({ focus: "README.md", collapse: "README.md" });
    const collapsed = buildRows(RESP, { viewMode: "list", dismissed: NONE, collapsed: new Set(["README.md"]) });
    expect(moveFocus(collapsed, "README.md", "right")).toEqual({ focus: "README.md", expand: "README.md" });
  });

  it("Right on an expanded file goes to its first match; Right on a match does nothing", () => {
    expect(moveFocus(list, "README.md", "right")).toEqual({ focus: "README.md:1:0" });
    expect(moveFocus(list, "README.md:1:0", "right")).toEqual({ focus: "README.md:1:0" });
  });

  it("Left on a match goes to its file; on a collapsed node to its parent folder", () => {
    expect(moveFocus(list, "src/services/agent/a.ts:9:1", "left")).toEqual({ focus: "src/services/agent/a.ts" });
    const collapsed = buildRows(RESP, {
      viewMode: "tree",
      dismissed: NONE,
      collapsed: new Set(["src/services/agent"]),
    });
    expect(moveFocus(collapsed, "src/services/agent", "left")).toEqual({ focus: "src/services" });
    expect(moveFocus(tree, "src/services/file-chunks.ts:7:2", "left")).toEqual({
      focus: "src/services/file-chunks.ts",
    });
  });

  it("Enter opens a match and toggles a file or folder", () => {
    const opened = moveFocus(list, "README.md:1:0", "enter");
    expect(opened.focus).toBe("README.md:1:0");
    expect(opened.open?.file).toBe("README.md");
    expect(opened.open?.match).toBe(RESP.results[0].matches[0]);
    expect(moveFocus(tree, "src/services", "enter")).toEqual({ focus: "src/services", collapse: "src/services" });
    const collapsed = buildRows(RESP, { viewMode: "tree", dismissed: NONE, collapsed: new Set(["tests/unit"]) });
    expect(moveFocus(collapsed, "tests/unit", "enter")).toEqual({ focus: "tests/unit", expand: "tests/unit" });
  });

  it("a focused row that is gone falls back to the first row", () => {
    expect(moveFocus(list, "gone.ts:1:1", "down").focus).toBe("README.md");
    expect(moveFocus([], null, "down").focus).toBeNull();
  });
});

describe("buildReplaceFiles", () => {
  const R = response([
    { file: "a.ts", matches: [m(1, 0, "foo", "bar"), m(4, 2, "Foo", "Bar")] },
    { file: "b.ts", matches: [m(2, 1, "foo", "bar")] },
    { file: "c.ts", matches: [m(3, 0, "foo")] }, // no replacement computed (grep + untranslatable regex)
  ]);

  it("everything left: every listed match with its replacement, dismissed ones excluded", () => {
    const out = buildReplaceFiles(R, new Set(["a.ts:4:2"]), { all: true });
    expect(out.files).toEqual([
      { file: "a.ts", matches: [{ line: 1, column: 0, text: "foo", replacement: "bar" }] },
      { file: "b.ts", matches: [{ line: 2, column: 1, text: "foo", replacement: "bar" }] },
    ]);
    expect(out.unsaved).toEqual([]);
    expect(out.matches).toBe(2);
  });

  it("one file: only that file's remaining matches", () => {
    const out = buildReplaceFiles(R, NONE, { file: "a.ts" });
    expect(out.files).toEqual([
      {
        file: "a.ts",
        matches: [
          { line: 1, column: 0, text: "foo", replacement: "bar" },
          { line: 4, column: 2, text: "Foo", replacement: "Bar" },
        ],
      },
    ]);
    expect(out.matches).toBe(2);
  });

  it("one match: only that match", () => {
    const out = buildReplaceFiles(R, NONE, { match: "a.ts:4:2" });
    expect(out.files).toEqual([{ file: "a.ts", matches: [{ line: 4, column: 2, text: "Foo", replacement: "Bar" }] }]);
  });

  it("a dismissed file sends nothing", () => {
    expect(buildReplaceFiles(R, new Set(["b.ts"]), { file: "b.ts" }).files).toEqual([]);
  });

  it("leaves unsaved files out and names them", () => {
    const out = buildReplaceFiles(R, NONE, { all: true }, (file) => file === "a.ts");
    expect(out.files.map((f) => f.file)).toEqual(["b.ts"]);
    expect(out.unsaved).toEqual(["a.ts"]);
    expect(out.matches).toBe(1);
  });

  it("is empty without a response", () => {
    expect(buildReplaceFiles(null, NONE, { all: true })).toEqual({ files: [], unsaved: [], matches: 0 });
  });
});

describe("filtersActive", () => {
  it("is off with empty fields and ignore files on", () => {
    expect(filtersActive({ include: "", exclude: "  ", useIgnore: true })).toBe(false);
  });

  it("is on with an include, an exclude, or ignore files off", () => {
    expect(filtersActive({ include: "src/**", exclude: "", useIgnore: true })).toBe(true);
    expect(filtersActive({ include: "", exclude: "*.lock", useIgnore: true })).toBe(true);
    expect(filtersActive({ include: "", exclude: "", useIgnore: false })).toBe(true);
  });

  it("ignores a field holding only commas and spaces", () => {
    expect(filtersActive({ include: " , ,", exclude: "", useIgnore: true })).toBe(false);
  });
});
