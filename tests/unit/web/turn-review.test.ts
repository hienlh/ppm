import { describe, expect, test } from "bun:test";
import { answerFiles, editKey, editReviews, turnReviewLabel, turnReviewSummary } from "../../../src/web/lib/turn-review.ts";
import type { FileEditFragment, TurnFileChange } from "../../../src/web/lib/aggregate-turn-file-changes.ts";
import type { SessionFileChange } from "../../../src/shared/session-file-changes.ts";

const edit = (toolUseId: string | undefined, editIndex = 0): FileEditFragment => ({
  oldStr: "a",
  newStr: "b",
  toolUseId,
  editIndex,
  editRef: toolUseId ? `${toolUseId}-${editIndex}` : undefined,
  viaSubagent: false,
});

const change = (filePath: string, edits: FileEditFragment[]): TurnFileChange => ({
  filePath,
  op: "edit",
  editCount: edits.length,
  linesAdded: 1,
  linesRemoved: 1,
  edits,
  viaSubagent: false,
});

const file = (path: string, blocks: SessionFileChange["blocks"], extra: Partial<SessionFileChange> = {}): SessionFileChange => ({
  path,
  status: "modified",
  baseline: "session",
  additions: 1,
  deletions: 1,
  version: `v:${path}`,
  blocks,
  ...extra,
});

const stateOf = (reviews: ReturnType<typeof editReviews>) => [...reviews.values()].map((r) => r.state);

describe("editReviews", () => {
  test("an edit is open until every block its call wrote is kept", () => {
    const changes = [change("/p/a.ts", [edit("toolu_1"), edit("toolu_2")])];
    const files = [file("/p/a.ts", [
      { key: "k1", added: 1, removed: 0, calls: ["toolu_1"] },
      { key: "k2", added: 1, removed: 0, kept: true, calls: ["toolu_1", "toolu_2"] },
    ])];
    const reviews = editReviews(changes, files, new Map());
    expect(stateOf(reviews)).toEqual(["open", "kept"]);
    expect(reviews.get(editKey("/p/a.ts", edit("toolu_1")))!.keys).toEqual(["k1", "k2"]);
    expect(reviews.get(editKey("/p/a.ts", edit("toolu_2")))!.file!.version).toBe("v:/p/a.ts");
  });

  test("an edit no block holds any more is reverted, once the list names who wrote what", () => {
    const changes = [change("/p/a.ts", [edit("toolu_1"), edit("toolu_2")])];
    const files = [file("/p/a.ts", [{ key: "k1", added: 1, removed: 0, calls: ["toolu_2"] }])];
    expect(stateOf(editReviews(changes, files, new Map()))).toEqual(["reverted", "open"]);
  });

  test("says nothing where the list cannot: no calls named, no blocks, a file it does not list", () => {
    const changes = [
      change("/p/old.ts", [edit("toolu_1")]),
      change("/p/bin.png", [edit("toolu_2")]),
      change("/p/gone.ts", [edit("toolu_3")]),
      change("/p/anon.ts", [edit(undefined)]),
    ];
    const files = [
      file("/p/old.ts", [{ key: "k", added: 1, removed: 0 }]),
      file("/p/bin.png", undefined, { binary: true }),
      file("/p/anon.ts", [{ key: "k", added: 1, removed: 0, calls: ["toolu_9"] }]),
    ];
    expect(stateOf(editReviews(changes, files, new Map()))).toEqual([null, null, null, null]);
  });

  test("a revert made here is reverted, with its undo, even where the file is no longer listed", () => {
    const e = edit("toolu_3");
    const reviews = editReviews([change("/p/gone.ts", [e])], [], new Map([[editKey("/p/gone.ts", e), "undo-1"]]));
    expect([...reviews.values()]).toEqual([{ state: "reverted", keys: [], undoId: "undo-1" }]);
  });

  test("what came before a mark of the whole file was reviewed: kept", () => {
    const changes = [change("/p/a.ts", [edit("toolu_1"), edit("toolu_2")])];
    const files = [file("/p/a.ts", [{ key: "k", added: 1, removed: 0, calls: ["toolu_2"] }], { sinceReview: true })];
    expect(stateOf(editReviews(changes, files, new Map()))).toEqual(["kept", "open"]);
  });

  test("matches a path written with backslashes to the one the list has", () => {
    const changes = [change("C:\\p\\a.ts", [edit("toolu_1")])];
    const files = [file("C:/p/a.ts", [{ key: "k", added: 1, removed: 0, calls: ["toolu_1"] }])];
    expect(stateOf(editReviews(changes, files, new Map()))).toEqual(["open"]);
  });
});

describe("turnReviewLabel", () => {
  test("says what is left, then how it went", () => {
    expect(turnReviewLabel({ open: 0, kept: 0, reverted: 0, known: 0 })).toBeNull();
    expect(turnReviewLabel({ open: 1, kept: 2, reverted: 1, known: 4 })).toEqual({ tone: "todo", text: "1 edit to review" });
    expect(turnReviewLabel({ open: 3, kept: 0, reverted: 0, known: 3 })!.text).toBe("3 edits to review");
    expect(turnReviewLabel({ open: 0, kept: 2, reverted: 1, known: 3 })).toEqual({ tone: "reverted", text: "1 reverted" });
    expect(turnReviewLabel({ open: 0, kept: 2, reverted: 0, known: 2 })).toEqual({ tone: "kept", text: "Kept" });
  });

  test("counts only the edits the list says anything about", () => {
    const changes = [change("/p/a.ts", [edit("toolu_1")]), change("/p/b.ts", [edit("toolu_2")])];
    const files = [file("/p/a.ts", [{ key: "k", added: 1, removed: 0, calls: ["toolu_1"] }])];
    expect(turnReviewSummary(editReviews(changes, files, new Map()))).toEqual({ open: 1, kept: 0, reverted: 0, known: 1 });
  });
});

describe("answerFiles", () => {
  const files = [
    file("/p/a.ts", [
      { key: "k1", added: 1, removed: 0, calls: ["toolu_1"] },
      { key: "k2", added: 1, removed: 0, kept: true, calls: ["toolu_1", "toolu_2"] },
    ]),
    file("/p/b.ts", [{ key: "k3", added: 1, removed: 0, calls: ["toolu_3"] }]),
  ];
  const changes = [change("/p/a.ts", [edit("toolu_1"), edit("toolu_2")]), change("/p/b.ts", [edit("toolu_3")])];
  const reviews = [...editReviews(changes, files, new Map()).values()];

  test("names each file once at the version drawn, with the open blocks for a keep", () => {
    expect(answerFiles(reviews, "open")).toEqual([
      { path: "/p/a.ts", version: "v:/p/a.ts", keys: ["k1"] },
      { path: "/p/b.ts", version: "v:/p/b.ts", keys: ["k3"] },
    ]);
  });

  test("names no file the answer would carry no block for, which the server refuses outright", () => {
    const allKept = editReviews([change("/p/a.ts", [edit("toolu_2")])], [file("/p/a.ts", [{ key: "k2", added: 1, removed: 0, kept: true, calls: ["toolu_2"] }])], new Map());
    expect(answerFiles([...allKept.values()], "open")).toEqual([]);
    const gone = editReviews([change("/p/a.ts", [edit("toolu_1")])], [file("/p/a.ts", [{ key: "k2", added: 1, removed: 0, calls: ["toolu_2"] }])], new Map());
    expect(answerFiles([...gone.values()], "all")).toEqual([]);
  });

  test("and every block an edit wrote for a revert or a reopen", () => {
    expect(answerFiles(reviews.slice(0, 2), "all")).toEqual([{ path: "/p/a.ts", version: "v:/p/a.ts", keys: ["k1", "k2"] }]);
    expect(answerFiles([{ state: "reverted", keys: [] }], "all")).toEqual([]);
  });
});
