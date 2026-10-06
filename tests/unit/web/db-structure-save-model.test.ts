/**
 * The "Error when saving" dialog lists every statement of the script with what became of it. The
 * list is only worth reading if it is true: a statement marked "Rolled back" that stayed applied
 * (MySQL commits each DDL statement), or SQLite's `PRAGMA foreign_keys = ON` marked "Did not run"
 * when it runs after the transaction whatever happened, sends the user looking for damage that is
 * not there — or away from damage that is.
 */
import { describe, expect, test } from "bun:test";
import {
  failureOf,
  newerPreviewOf,
  statementReports,
} from "../../../src/web/components/database/table-editor/structure-save-model";
import type { StructureStatement } from "../../../src/shared/db-structure-change";

const s = (sql: string, phase?: "before" | "after"): StructureStatement => (phase ? { sql, phase } : { sql });

/** SQLite's rebuild of a table, as `sqlite-recreate.ts` plans it. */
const REBUILD: StructureStatement[] = [
  s("PRAGMA foreign_keys = OFF;", "before"),
  s(`CREATE TABLE "new_t" ("id" INTEGER PRIMARY KEY, "a" TEXT NOT NULL);`),
  s(`INSERT INTO "new_t" ("id", "a") SELECT "id", "a" FROM "t";`),
  s(`DROP TABLE "t";`),
  s(`ALTER TABLE "new_t" RENAME TO "t";`),
  s("-- PPM compiles every view and trigger, which the rebuild can leave naming what t no longer has"),
  s("PRAGMA foreign_key_check;"),
  s("PRAGMA foreign_keys = ON;", "after"),
];

const outcomes = (reports: { sql: string; outcome: string | null }[]) => reports.map((r) => r.outcome);

describe("statementReports", () => {
  test("in one transaction, what ran before the failure is rolled back and what follows never ran", () => {
    const reports = statementReports({ statements: [s("A;"), s("B;"), s("C;")], transactional: true }, { index: 1 });
    expect(reports).toEqual([
      { sql: "A;", outcome: "rolled-back" },
      { sql: "B;", outcome: "failed" },
      { sql: "C;", outcome: "not-run" },
    ]);
  });

  test("on MySQL, what ran before the failure stays applied", () => {
    const reports = statementReports({ statements: [s("A;"), s("B;"), s("C;")], transactional: false }, { index: 2 });
    expect(outcomes(reports)).toEqual(["ran", "ran", "failed"]);
  });

  test("SQLite's pragmas outside the transaction ran, even the one after a statement that failed", () => {
    const reports = statementReports({ statements: REBUILD, transactional: true }, { index: 2 });
    expect(outcomes(reports)).toEqual(["ran", "rolled-back", "failed", "not-run", "not-run", null, "not-run", "ran"]);
  });

  test("a failed COMMIT is listed after the transaction's statements and before the ones that run after it", () => {
    const reports = statementReports({ statements: REBUILD, transactional: true }, { index: -1 });
    expect(reports.map((r) => r.sql)).toEqual([...REBUILD.slice(0, 7).map((x) => x.sql), "COMMIT;", REBUILD[7]!.sql]);
    expect(outcomes(reports)).toEqual(["ran", "rolled-back", "rolled-back", "rolled-back", "rolled-back", null, "rolled-back", "failed", "ran"]);
  });

  test("a failed COMMIT with nothing after the transaction is listed last", () => {
    const reports = statementReports({ statements: [s("A;"), s("B;")], transactional: true }, { index: -1 });
    expect(reports).toEqual([
      { sql: "A;", outcome: "rolled-back" },
      { sql: "B;", outcome: "rolled-back" },
      { sql: "COMMIT;", outcome: "failed" },
    ]);
  });

  test("a comment has no outcome, unless it stands for the check that failed", () => {
    expect(statementReports({ statements: REBUILD, transactional: true }, { index: 6 })[5]!.outcome).toBeNull();
    const failedCheck = statementReports({ statements: REBUILD, transactional: true }, { index: 5 });
    expect(outcomes(failedCheck)).toEqual(["ran", "rolled-back", "rolled-back", "rolled-back", "rolled-back", "failed", "not-run", "ran"]);
  });

  test("a failure before the transaction leaves the whole transaction unrun", () => {
    const reports = statementReports({ statements: REBUILD, transactional: true }, { index: 0 });
    expect(outcomes(reports)).toEqual(["failed", "not-run", "not-run", "not-run", "not-run", null, "not-run", "ran"]);
  });
});

describe("newerPreviewOf", () => {
  const body = (data: unknown) => ({ ok: false, error: "changed", data });

  test("reads the script a 409 carries, statement phases included", () => {
    expect(newerPreviewOf(body({
      sql: "PRAGMA foreign_keys = OFF;\nX;\nPRAGMA foreign_keys = ON;",
      statements: [{ sql: "PRAGMA foreign_keys = OFF;", phase: "before" }, { sql: "X;" }, { sql: "PRAGMA foreign_keys = ON;", phase: "after" }],
      recreate: true, warnings: ["w", 3], transactional: true,
    }))).toEqual({
      sql: "PRAGMA foreign_keys = OFF;\nX;\nPRAGMA foreign_keys = ON;",
      statements: [s("PRAGMA foreign_keys = OFF;", "before"), s("X;"), s("PRAGMA foreign_keys = ON;", "after")],
      recreate: true, warnings: ["w"], transactional: true,
    });
  });

  test("MySQL's answer says it is not one transaction", () => {
    expect(newerPreviewOf(body({ sql: "X;", statements: [{ sql: "X;" }], recreate: false, warnings: [], transactional: false }))?.transactional).toBe(false);
  });

  test("anything that is not a script is not a newer preview", () => {
    expect(newerPreviewOf(body(null))).toBeNull();
    expect(newerPreviewOf({ ok: false, error: "x" })).toBeNull();
    expect(newerPreviewOf(body({ sql: "X;" }))).toBeNull();
    expect(newerPreviewOf(body({ sql: "X;", statements: ["X;"], recreate: false, transactional: true }))).toBeNull();
    expect(newerPreviewOf(body({ sql: "X;", statements: [{ sql: "X;", phase: "during" }], recreate: false, transactional: true }))).toBeNull();
    expect(newerPreviewOf(body({ sql: 1, statements: [], recreate: false, transactional: true }))).toBeNull();
    // Without them the report could call applied statements rolled back.
    expect(newerPreviewOf(body({ sql: "X;", statements: [{ sql: "X;" }], recreate: false }))).toBeNull();
    expect(newerPreviewOf(body({ sql: "X;", statements: [{ sql: "X;" }], transactional: true }))).toBeNull();
  });
});

describe("failureOf", () => {
  test("reads where the script stopped", () => {
    expect(failureOf({ data: { statement: "B", index: 1, applied: 0, total: 3 } })).toEqual({ statement: "B", index: 1, applied: 0, total: 3 });
    expect(failureOf({ data: { statement: "COMMIT", index: -1 } })).toEqual({ statement: "COMMIT", index: -1, applied: 0, total: 0 });
  });

  test("an error with no place in the script has no failure", () => {
    expect(failureOf({ data: null })).toBeNull();
    expect(failureOf({ data: { statement: "B", index: 1.5 } })).toBeNull();
    expect(failureOf({ data: { index: 1 } })).toBeNull();
    expect(failureOf(undefined)).toBeNull();
  });
});
