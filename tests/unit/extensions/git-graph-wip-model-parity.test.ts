/**
 * The Git Graph's uncommitted-changes arithmetic is a copy of Source Control's
 * (the extension ships beside the install and cannot import PPM's source), so
 * both are run over the same working trees here. Two surfaces telling one user
 * "3 of 7 blocks staged" and "2 of 6" is the drift this is for.
 *
 * The webview does not run the typed module either: it runs `WIP_MODEL_JS`,
 * the same functions as source. That copy is evaluated on its own below, which
 * is what catches a helper that quietly reaches for something in its module's
 * scope — it works in the typed module and is `undefined` in the panel.
 */
import { describe, expect, it } from "bun:test";
import type { ChangedFile, ChangeSide, GitBranchState, GitOperation } from "../../../src/shared/git-changes";
import * as web from "../../../src/web/lib/git-changes-view";
import * as port from "../../../packages/ext-git-graph/src/wip-model.ts";

type Port = typeof port;
const NAMES = [
  "blockAnchor", "plural", "splitPath", "fileCheckState", "allCheckState", "changeLetter", "changeLetterName",
  "changeCounts", "lineNote", "blockDots", "hasUnstaged", "unstagePaths", "changeTotals", "syncMode",
  "commitLabel", "commitHint", "canCommit", "discardSummary", "operationTitle", "operationNoun",
] as const;
const injected = new Function(`${port.WIP_MODEL_JS}\nreturn { ${NAMES.join(", ")} };`)() as Pick<Port, (typeof NAMES)[number]>;

let n = 0;
const block = (oldStart: number, oldLines: number, newStart: number, newLines: number, added = 1, removed = 1) =>
  ({ id: `b${n++}`, index: 0, oldStart, oldLines, newStart, newLines, added, removed });
const side = (blocks: ReturnType<typeof block>[], extra: Partial<ChangeSide> = {}): ChangeSide => ({
  blocks,
  added: blocks.reduce((sum, b) => sum + b.added, 0),
  removed: blocks.reduce((sum, b) => sum + b.removed, 0),
  ...extra,
});
const file = (over: Partial<ChangedFile>): ChangedFile => ({
  path: "src/a.ts", x: ".", y: ".", untracked: false, conflict: false, staged: null, unstaged: null, ...over,
});
const branch = (over: Partial<GitBranchState> = {}): GitBranchState => ({
  head: "main", oid: "abc", upstream: "origin/main", upstreamGone: false, ahead: 0, behind: 0, hasRemote: true, ...over,
});

const FILES: ChangedFile[] = [
  file({ path: "staged.ts", x: "M", staged: side([block(1, 1, 1, 1)]) }),
  file({ path: "src/partly.ts", x: "M", y: "M", staged: side([block(9, 1, 9, 2)]), unstaged: side([block(1, 1, 1, 1), block(20, 0, 21, 3, 3, 0)]) }),
  file({ path: "src/web/open.tsx", y: "M", unstaged: side([block(4, 2, 4, 0, 0, 2), block(4, 0, 5, 1, 1, 0)]) }),
  file({ path: "notes.md", x: "?", y: "?", untracked: true, unstaged: side([block(0, 0, 1, 3, 3, 0)]) }),
  file({ path: "merge.ts", x: "U", y: "U", conflict: true }),
  file({ path: "lib/new-name.ts", oldPath: "lib/old-name.ts", x: "R", staged: side([], { whole: "rename" }) }),
  file({ path: "img/logo.png", y: "M", unstaged: side([], { whole: "binary", added: 0, removed: 0 }) }),
  file({ path: "vendor/sub", x: "M", staged: side([], { whole: "submodule" }), unstaged: side([], { whole: "submodule" }) }),
  file({ path: "gone.ts", y: "D", unstaged: side([block(1, 4, 0, 0, 0, 4)]) }),
  file({ path: "added.ts", x: "A", staged: side([block(0, 0, 1, 2, 2, 0)]) }),
  file({ path: "script.sh", y: "M", unstaged: side([], { whole: "mode" }) }),
  file({ path: "empty.txt", x: "A", staged: side([], { whole: "empty" }) }),
];

const SETS: ChangedFile[][] = [[], [FILES[0]!], FILES.slice(0, 3), FILES.slice(3, 6), FILES, [FILES[4]!], [FILES[3]!, FILES[2]!]];

const BRANCHES: GitBranchState[] = [
  branch(),
  branch({ ahead: 2 }),
  branch({ behind: 3 }),
  branch({ ahead: 1, behind: 1 }),
  branch({ upstream: null }),
  branch({ upstreamGone: true, ahead: 4 }),
  branch({ head: null }),
  branch({ hasRemote: false, upstream: null }),
];

const OPERATIONS: GitOperation[] = [
  { kind: "merge", name: "feature/x" },
  { kind: "merge", head: "abc1234" },
  { kind: "merge" },
  { kind: "rebase", name: "topic", step: 2, total: 5 },
  { kind: "rebase" },
  { kind: "cherry-pick", head: "def5678" },
  { kind: "revert" },
  { kind: "am", step: 1, total: 3 },
];

describe.each([
  ["the typed port", port as Pick<Port, (typeof NAMES)[number]>],
  ["the source the webview runs", injected],
])("%s agrees with Source Control", (_label, impl) => {
  it("about each file", () => {
    for (const f of FILES) {
      expect(impl.fileCheckState(f)).toBe(web.fileCheckState(f));
      expect(impl.changeLetter(f)).toBe(web.changeLetter(f));
      expect(impl.changeLetterName(impl.changeLetter(f))).toBe(web.CHANGE_LETTER_NAME[web.changeLetter(f)]);
      expect(impl.changeCounts(f)).toEqual(web.changeCounts(f));
      expect(impl.lineNote(f)).toBe(web.lineNote(f));
      expect(impl.blockDots(f)).toEqual(web.blockDots(f));
      expect(impl.hasUnstaged(f)).toBe(web.hasUnstaged(f));
      expect(impl.unstagePaths(f)).toEqual(web.unstagePaths(f));
      expect(impl.splitPath(f.path)).toEqual(web.splitPath(f.path));
      expect(impl.discardSummary([f])).toEqual(web.discardSummary([f]));
    }
  });

  it("about a set of files and the commit box under it", () => {
    for (const files of SETS) {
      const totals = web.changeTotals(files);
      expect(impl.changeTotals(files)).toEqual(totals);
      expect(impl.allCheckState(files)).toBe(web.allCheckState(files));
      expect(impl.commitLabel(totals)).toBe(web.commitLabel(totals));
      for (const message of ["", "   ", "Fix the thing"]) {
        expect(impl.commitHint(totals, message)).toBe(web.commitHint(totals, message));
        expect(impl.commitHint(totals, message, "Ctrl+Enter")).toBe(web.commitHint(totals, message, "Ctrl+Enter"));
        expect(impl.canCommit(totals, message)).toBe(web.canCommit(totals, message));
      }
      if (files.length > 1) expect(impl.discardSummary(files)).toEqual(web.discardSummary(files));
    }
  });

  it("about the branch and a stopped operation", () => {
    for (const b of BRANCHES) expect(impl.syncMode(b)).toBe(web.syncMode(b));
    for (const op of OPERATIONS) {
      for (const on of ["main", null]) expect(impl.operationTitle(op, on)).toBe(web.operationTitle(op, on));
      expect(impl.operationNoun(op.kind)).toBe(web.OPERATION_NOUN[op.kind]);
    }
  });
});

describe("the webview's copy", () => {
  it("ships every helper the typed module exports", () => {
    // A function exported and used by the panel but missing from the list is a
    // ReferenceError the first time the WIP row renders.
    const exported = Object.entries(port).filter(([, v]) => typeof v === "function").map(([k]) => k).sort();
    expect([...NAMES].sort()).toEqual(exported);
  });
});
