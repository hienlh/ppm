/**
 * The diagnostics store behind the Problems panel.
 *
 * Diagnostics are republished wholesale by a language server on every keystroke
 * that changes the analysis, so the store's job is entirely about replacing and
 * removing: a fixed file must stop being listed, a closed file must not outlive
 * its editor, and two projects with a same-named file must not collide.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  useProblemsStore,
  filesForProject,
  problemKey,
  problemCounts,
  sortedProblems,
  type FileProblems,
} from "../../../src/web/stores/problems-store.ts";
import type { LspDiagnostic } from "../../../src/web/hooks/use-lsp.ts";

function diagnostic(line: number, severity: number, message = "bad", character = 0): LspDiagnostic {
  return {
    message,
    severity,
    range: { start: { line, character }, end: { line, character: character + 3 } },
  };
}

const store = () => useProblemsStore.getState();

beforeEach(() => {
  useProblemsStore.setState({ files: {} });
});

describe("publish", () => {
  it("keeps a file's diagnostics under its own key", () => {
    store().publish("app", "src/a.ts", [diagnostic(1, 1)]);

    expect(sortedProblems(store().files)).toEqual([
      { projectName: "app", filePath: "src/a.ts", diagnostics: [diagnostic(1, 1)] },
    ]);
  });

  it("replaces rather than appends, because servers republish the whole file", () => {
    store().publish("app", "src/a.ts", [diagnostic(1, 1), diagnostic(2, 1)]);
    store().publish("app", "src/a.ts", [diagnostic(2, 1)]);

    expect(store().files[problemKey("app", "src/a.ts")]!.diagnostics).toHaveLength(1);
  });

  it("drops the file once its problems are fixed", () => {
    // An empty entry would list a file with nothing under it and make the
    // panel's own "no problems" state unreachable.
    store().publish("app", "src/a.ts", [diagnostic(1, 1)]);
    store().publish("app", "src/a.ts", []);

    expect(store().files).toEqual({});
  });

  it("does not churn state when a clean file is published again", () => {
    store().publish("app", "src/a.ts", [diagnostic(1, 1)]);
    store().publish("app", "src/a.ts", []);
    const before = store().files;

    store().publish("app", "src/a.ts", []);

    expect(store().files).toBe(before);
  });

  it("keeps same-named files in different projects apart", () => {
    store().publish("app", "src/index.ts", [diagnostic(1, 1)]);
    store().publish("api", "src/index.ts", [diagnostic(9, 2)]);

    expect(Object.keys(store().files)).toHaveLength(2);
  });
});

describe("clear", () => {
  it("removes a closed file's problems", () => {
    store().publish("app", "src/a.ts", [diagnostic(1, 1)]);
    store().clear("app", "src/a.ts");

    expect(store().files).toEqual({});
  });

  it("leaves other files alone", () => {
    store().publish("app", "src/a.ts", [diagnostic(1, 1)]);
    store().publish("app", "src/b.ts", [diagnostic(1, 2)]);
    store().clear("app", "src/a.ts");

    expect(Object.keys(store().files)).toEqual([problemKey("app", "src/b.ts")]);
  });

  it("is a no-op for a file that has none", () => {
    const before = store().files;
    store().clear("app", "src/missing.ts");

    expect(store().files).toBe(before);
  });
});

describe("problemCounts", () => {
  it("totals errors and warnings across files", () => {
    store().publish("app", "src/a.ts", [diagnostic(1, 1), diagnostic(2, 2)]);
    store().publish("app", "src/b.ts", [diagnostic(1, 1)]);

    expect(problemCounts(store().files)).toEqual({ errors: 2, warnings: 1 });
  });

  it("ignores information and hints", () => {
    store().publish("app", "src/a.ts", [diagnostic(1, 3), diagnostic(2, 4)]);

    expect(problemCounts(store().files)).toEqual({ errors: 0, warnings: 0 });
  });

  it("counts a diagnostic with no severity as neither", () => {
    // LSP treats an absent severity as an error, but the count is only used to
    // colour a status item; guessing there would overstate it.
    store().publish("app", "src/a.ts", [{ message: "x", range: diagnostic(0, 1).range }]);

    expect(problemCounts(store().files)).toEqual({ errors: 0, warnings: 0 });
  });

  it("is zero for an empty store", () => {
    expect(problemCounts({})).toEqual({ errors: 0, warnings: 0 });
  });
});

describe("sortedProblems", () => {
  it("orders files by path so the list does not reshuffle", () => {
    store().publish("app", "src/z.ts", [diagnostic(1, 1)]);
    store().publish("app", "src/a.ts", [diagnostic(1, 1)]);

    expect(sortedProblems(store().files).map((f) => f.filePath)).toEqual(["src/a.ts", "src/z.ts"]);
  });

  it("orders a file's diagnostics by line then column", () => {
    store().publish("app", "src/a.ts", [
      diagnostic(9, 1, "third"),
      diagnostic(2, 1, "second", 7),
      diagnostic(2, 1, "first", 1),
    ]);

    expect(sortedProblems(store().files)[0]!.diagnostics.map((d) => d.message)).toEqual([
      "first", "second", "third",
    ]);
  });

  it("does not mutate the stored arrays", () => {
    store().publish("app", "src/a.ts", [diagnostic(9, 1), diagnostic(1, 1)]);
    const stored = store().files[problemKey("app", "src/a.ts")]!.diagnostics;

    sortedProblems(store().files);

    expect(stored[0]!.range.start.line).toBe(9);
  });
});

describe("filesForProject", () => {
  const files: Record<string, FileProblems> = {
    [problemKey("app", "src/a.ts")]: { projectName: "app", filePath: "src/a.ts", diagnostics: [diagnostic(1, 1)] },
    [problemKey("api", "src/b.ts")]: { projectName: "api", filePath: "src/b.ts", diagnostics: [diagnostic(1, 2)] },
  };

  it("keeps only the named project's files", () => {
    expect(Object.keys(filesForProject(files, "app"))).toEqual([problemKey("app", "src/a.ts")]);
  });

  it("passes everything through when no project is active", () => {
    expect(filesForProject(files, null)).toBe(files);
  });

  it("yields nothing for a project with no open files", () => {
    expect(filesForProject(files, "other")).toEqual({});
  });
});
