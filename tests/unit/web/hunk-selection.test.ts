import { describe, it, expect } from "bun:test";
import {
  allChangedKeys,
  buildHunkRequest,
  changedLineIndexes,
  hunkState,
  lineKey,
  lineNumbers,
  toggleHunk,
  toggleLine,
  type DiffHunk,
} from "../../../src/web/components/git/hunk-selection.ts";

/** Two hunks; the first replaces a line, the second replaces one and adds one. */
const HUNKS: DiffHunk[] = [
  {
    oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, heading: "function a()",
    lines: [
      { kind: " ", text: "const a = 1;" },
      { kind: "-", text: "const b = 2;" },
      { kind: "+", text: "const b = 20;" },
      { kind: " ", text: "const c = 3;" },
    ],
  },
  {
    oldStart: 10, oldLines: 3, newStart: 10, newLines: 4, heading: "",
    lines: [
      { kind: " ", text: "const x = 1;" },
      { kind: "-", text: "const y = 2;" },
      { kind: "+", text: "const y = 20;" },
      { kind: "+", text: "const z = 30;" },
      { kind: " ", text: "const w = 4;" },
    ],
  },
];

const everything = () => new Set(allChangedKeys(HUNKS));

describe("changedLineIndexes", () => {
  it("skips context lines", () => {
    expect(changedLineIndexes(HUNKS[0]!)).toEqual([1, 2]);
    expect(changedLineIndexes(HUNKS[1]!)).toEqual([1, 2, 3]);
  });
});

describe("allChangedKeys", () => {
  it("keys every changed line by hunk and line index", () => {
    expect(allChangedKeys(HUNKS)).toEqual(["0:1", "0:2", "1:1", "1:2", "1:3"]);
  });
});

describe("hunkState", () => {
  it("counts what is ticked within one hunk", () => {
    expect(hunkState(HUNKS, 1, everything())).toEqual({ picked: 3, total: 3 });
    expect(hunkState(HUNKS, 1, new Set([lineKey(1, 2)]))).toEqual({ picked: 1, total: 3 });
  });

  it("reports nothing for a hunk that does not exist", () => {
    expect(hunkState(HUNKS, 9, everything())).toEqual({ picked: 0, total: 0 });
  });
});

describe("toggleHunk", () => {
  it("unticks a fully ticked hunk without touching the other", () => {
    const next = toggleHunk(HUNKS, 0, everything());

    expect(hunkState(HUNKS, 0, next).picked).toBe(0);
    expect(hunkState(HUNKS, 1, next).picked).toBe(3);
  });

  it("ticks the rest of a partly ticked hunk rather than clearing it", () => {
    const next = toggleHunk(HUNKS, 1, new Set([lineKey(1, 2)]));

    expect(hunkState(HUNKS, 1, next)).toEqual({ picked: 3, total: 3 });
  });

  it("leaves the selection alone for a hunk that does not exist", () => {
    const before = everything();

    expect(toggleHunk(HUNKS, 9, before)).toBe(before);
  });
});

describe("toggleLine", () => {
  it("adds and removes one line", () => {
    const on = toggleLine(0, 1, new Set());
    expect(on.has("0:1")).toBe(true);

    expect(toggleLine(0, 1, on).has("0:1")).toBe(false);
  });

  it("does not mutate the set it was given", () => {
    const before = new Set<string>();
    toggleLine(0, 1, before);

    expect(before.size).toBe(0);
  });
});

describe("buildHunkRequest", () => {
  it("sends a fully ticked hunk whole, with no line list", () => {
    expect(buildHunkRequest(HUNKS, everything())).toEqual([{ hunk: 0 }, { hunk: 1 }]);
  });

  it("narrows a partly ticked hunk to its ticked line indexes", () => {
    const selected = new Set([lineKey(1, 1), lineKey(1, 2)]);

    expect(buildHunkRequest(HUNKS, selected)).toEqual([{ hunk: 1, lines: [1, 2] }]);
  });

  it("leaves out a hunk with nothing ticked instead of sending it empty", () => {
    const selected = new Set([lineKey(0, 2)]);

    expect(buildHunkRequest(HUNKS, selected)).toEqual([{ hunk: 0, lines: [2] }]);
  });

  it("returns nothing when the selection is empty", () => {
    expect(buildHunkRequest(HUNKS, new Set())).toEqual([]);
  });

  it("numbers hunks by their position in the diff, not by what is selected", () => {
    // Only the second hunk is picked; it must still be sent as index 1.
    expect(buildHunkRequest(HUNKS, new Set([lineKey(1, 3)]))).toEqual([{ hunk: 1, lines: [3] }]);
  });
});

describe("lineNumbers", () => {
  it("gives an addition no old number and a deletion no new one", () => {
    expect(lineNumbers(HUNKS[1]!)).toEqual([
      { old: "10", next: "10" },
      { old: "11", next: "" },
      { old: "", next: "11" },
      { old: "", next: "12" },
      { old: "12", next: "13" },
    ]);
  });
});
