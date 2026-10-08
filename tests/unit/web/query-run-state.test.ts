import { describe, expect, it } from "bun:test";
import {
  applyQueryEvents as applyTimed, countOf, failQueryRun, MESSAGES_TAB, noteOnQueryRun, refusedAsReadonly, replaceResultSet, resultEditability,
  resultOfTab, shownResultTab, startQueryRun, stopTitle, type QueryRun, type QueryRunKind,
} from "../../../src/web/components/database/query/query-run-state";
import type { QueryResultSet, QueryScriptEvent, QueryStatementResult } from "../../../src/shared/db-query-script";
import type { DbColumnInfo } from "../../../src/web/components/database/use-database";

function begin(options: { kind?: QueryRunKind; lineOffset?: number; startedAt?: number } = {}): QueryRun {
  return startQueryRun(
    { runId: "r1", kind: options.kind ?? "script", sql: "…", lineOffset: options.lineOffset ?? 0, maxRows: 1000 },
    options.startedAt ?? 1_000,
  );
}

function set(rows: unknown[][], columns = ["id"], truncated?: boolean): QueryResultSet {
  return { columns: columns.map((name) => ({ name, type: "int4" })), rows, ...(truncated ? { truncated } : {}) };
}

function statement(index: number, line: number, more: Partial<QueryStatementResult> = {}): QueryScriptEvent {
  return { type: "statement", result: { index, startLine: line, endLine: line, sql: `stmt ${index}`, resultSets: [], durationMs: 5, ...more } };
}

const texts = (run: QueryRun) => run.messages.map((m) => m.text);

/** Every event arriving at `at`. */
function applyQueryEvents(run: QueryRun, events: QueryScriptEvent[], at: number): QueryRun {
  return applyTimed(run, events.map((event) => ({ event, at })));
}

describe("a script's run", () => {
  it("gives each result a tab and says what each statement did, as DBGate does", () => {
    const run = applyQueryEvents(begin(), [
      { type: "start", statements: [{ startLine: 1, endLine: 2 }, { startLine: 4, endLine: 4 }, { startLine: 6, endLine: 6 }] },
      { type: "running", index: 0 },
      statement(0, 1, { endLine: 2, command: "SELECT", resultSets: [set([[1], [2]])], durationMs: 41 }),
      { type: "running", index: 1 },
      statement(1, 4, { command: "UPDATE", rowsAffected: 1, durationMs: 6 }),
      { type: "running", index: 2 },
      statement(2, 6, { command: "SELECT", resultSets: [set([[1], [2], [3], [4]])], durationMs: 12 }),
      { type: "done", durationMs: 70 },
    ], 2_000);

    expect(run.tabs).toEqual([
      { key: "0:0", title: "Result 1", statement: 0, set: 0 },
      { key: "2:0", title: "Result 2", statement: 2, set: 0 },
    ]);
    expect(run.messages).toEqual([
      { id: 0, level: "info", text: "Query execution started", time: 1_000 },
      { id: 1, level: "success", text: "Query returned 2 rows in 41 ms", statement: 0, line: 1, time: 2_000 },
      { id: 2, level: "success", text: "1 row affected", statement: 1, line: 4, time: 2_000 },
      { id: 3, level: "success", text: "Query returned 4 rows in 12 ms", statement: 2, line: 6, time: 2_000 },
      { id: 4, level: "info", text: "Query execution finished", time: 2_000 },
    ]);
    expect(run).toMatchObject({ done: true, failed: false, durationMs: 70, running: null, errorLines: [] });
    expect(run.statements).toEqual([{ startLine: 1, endLine: 2 }, { startLine: 4, endLine: 4 }, { startLine: 6, endLine: 6 }]);
  });

  it("puts the server's lines back where the text sent begins in the editor", () => {
    const run = applyQueryEvents(begin({ lineOffset: 7 }), [
      { type: "start", statements: [{ startLine: 1, endLine: 3 }] },
      statement(0, 1, { endLine: 3, error: "syntax error at or near \"FORM\"", errorLine: 2 }),
    ], 0);
    expect(run.statements).toEqual([{ startLine: 8, endLine: 10 }]);
    expect(run.results[0]).toMatchObject({ startLine: 8, endLine: 10, errorLine: 9 });
    expect(run.messages.at(-1)).toMatchObject({ level: "error", line: 9, statement: 0, text: "syntax error at or near \"FORM\"" });
    expect(run.errorLines).toEqual([9]);
  });

  it("points an error the server could not place at its statement, and says what did not run", () => {
    const run = applyQueryEvents(begin({ lineOffset: 2 }), [
      { type: "start", statements: [{ startLine: 1, endLine: 1 }, { startLine: 2, endLine: 2 }, { startLine: 3, endLine: 3 }, { startLine: 4, endLine: 4 }] },
      statement(0, 1, { rowsAffected: 0 }),
      statement(1, 2, { error: "column \"statuss\" does not exist" }),
      { type: "done", durationMs: 9 },
    ], 0);
    expect(run.failed).toBe(true);
    expect(run.errorLines).toEqual([4]);
    expect(texts(run)).toEqual([
      "Query execution started", "0 rows affected", "column \"statuss\" does not exist", "2 statements did not run", "Query execution finished",
    ]);
    expect(run.messages[2]).toMatchObject({ level: "error", line: 4 });
  });

  it("gives an empty SELECT a tab and a statement without columns none", () => {
    const run = applyQueryEvents(begin(), [
      statement(0, 1, { command: "SELECT", resultSets: [set([])] }),
      statement(1, 2, { command: "CREATE TABLE", resultSets: [{ columns: [], rows: [] }] }),
      statement(2, 3),
    ], 0);
    expect(run.tabs.map((t) => t.key)).toEqual(["0:0"]);
    expect(texts(run).slice(1)).toEqual(["Query returned 0 rows in 5 ms", "CREATE TABLE executed", "Statement executed"]);
  });

  it("gives every result of one statement a tab — a MySQL CALL — and times the statement once", () => {
    const run = applyQueryEvents(begin(), [statement(0, 1, { resultSets: [set([[1]]), set([[1], [2]])], durationMs: 1_234 })], 0);
    expect(run.tabs.map((t) => [t.key, t.title])).toEqual([["0:0", "Result 1"], ["0:1", "Result 2"]]);
    expect(texts(run).slice(1)).toEqual(["Query returned 1 row in 1,234 ms", "Query returned 2 rows"]);
  });

  it("warns when the row limit cut a result short", () => {
    const run = applyQueryEvents(begin(), [statement(0, 1, { resultSets: [set(Array.from({ length: 1000 }, (_, i) => [i]), ["id"], true)] })], 0);
    expect(run.messages[1]).toMatchObject({ level: "warning", text: "Query returned the first 1,000 rows in 5 ms; the rest were cut off by the row limit" });
  });

  it("lists a statement's notices before what it did", () => {
    const run = applyQueryEvents(begin(), [statement(0, 3, { notices: ["table \"t\" does not exist, skipping"], command: "DROP TABLE", durationMs: 4 })], 7);
    expect(run.messages.slice(1)).toEqual([
      { id: 1, level: "info", text: "table \"t\" does not exist, skipping", statement: 0, line: 3, time: 7 },
      { id: 2, level: "success", text: "DROP TABLE executed", statement: 0, line: 3, time: 7 },
    ]);
  });

  it("times each message by when its event arrived", () => {
    const run = applyTimed(begin({ startedAt: 100 }), [
      { event: { type: "running", index: 0 }, at: 110 },
      { event: statement(0, 1), at: 150 },
      { event: { type: "running", index: 1 }, at: 151 },
      { event: statement(1, 2, { error: "boom" }), at: 420 },
      { event: { type: "done", durationMs: 321 }, at: 425 },
    ]);
    expect(run.messages.map((m) => m.time)).toEqual([100, 150, 420, 425]);
    expect(run.running).toBeNull();
  });

  it("says a statement was stopped, by Stop or by the timeout, and counts it as failed", () => {
    const byUser = applyQueryEvents(begin(), [statement(0, 1, { error: "canceling statement due to user request", stopped: "user" })], 0);
    expect(byUser.messages[1]).toMatchObject({ level: "error", text: "Stopped: canceling statement due to user request" });
    expect(byUser.failed).toBe(true);

    const timedOut = applyQueryEvents(begin(), [statement(0, 1, { error: "Stopped after the connection's query timeout (1 s): canceled", stopped: "timeout" })], 0);
    expect(timedOut.messages[1]!.text).toBe("Stopped after the connection's query timeout (1 s): canceled");

    // MySQL ends a SLEEP() it was told to stop as if it had finished, with a row.
    const sleep = applyQueryEvents(begin(), [statement(0, 1, { resultSets: [set([[1]], ["SLEEP(30)"])], stopped: "user" })], 0);
    expect(texts(sleep).slice(1)).toEqual(["Query returned 1 row in 5 ms", "Stopped"]);
    expect(sleep).toMatchObject({ failed: true, errorLines: [] });
    const sleepTimedOut = applyQueryEvents(begin(), [statement(0, 1, { stopped: "timeout" })], 0);
    expect(sleepTimedOut.messages[1]).toMatchObject({ level: "warning", text: "Stopped: the connection's query timeout was reached" });
  });

  it("knows which statement is running, and since when", () => {
    let run = applyQueryEvents(begin(), [{ type: "running", index: 0 }], 5_000);
    expect(run.running).toEqual({ index: 0, since: 5_000 });
    run = applyQueryEvents(run, [statement(0, 1)], 5_100);
    expect(run.running).toBeNull();
    run = applyQueryEvents(run, [{ type: "running", index: 1 }], 5_200);
    // A statement reported for another index leaves the running one alone.
    expect(applyQueryEvents(run, [statement(0, 1)], 5_300).running).toEqual({ index: 1, since: 5_200 });
    expect(applyQueryEvents(run, [{ type: "done", durationMs: 1 }], 5_300).running).toBeNull();
  });

  it("shows what is said about the run itself, an error failing it", () => {
    const info = applyQueryEvents(begin(), [{ type: "message", level: "info", text: "Connected" }], 0);
    expect(info.messages[1]).toEqual({ id: 1, level: "info", text: "Connected", time: 0 });
    expect(info.failed).toBe(false);
    const rolledBack = applyQueryEvents(begin(), [{ type: "message", level: "error", text: "rolled back" }], 0);
    expect(rolledBack.failed).toBe(true);
  });

  it("says why a run broke off before saying it finished", () => {
    const run = applyQueryEvents(begin(), [
      { type: "start", statements: [{ startLine: 1, endLine: 1 }] },
      { type: "done", durationMs: 3, error: "Connection terminated unexpectedly" },
    ], 0);
    expect(texts(run)).toEqual(["Query execution started", "Connection terminated unexpectedly", "1 statement did not run", "Query execution finished"]);
    expect(run.messages[1]!.level).toBe("error");
    expect(run.failed).toBe(true);
  });

  it("names an Explain's results as plans", () => {
    const run = applyQueryEvents(begin({ kind: "explain" }), [statement(0, 1, { resultSets: [set([["Seq Scan"]], ["QUERY PLAN"])] }), statement(1, 2, { resultSets: [set([[1]])] })], 0);
    expect(run.tabs.map((t) => t.title)).toEqual(["Plan", "Plan 2"]);
  });

  it("leaves the run it was given as it was", () => {
    const before = applyQueryEvents(begin(), [statement(0, 1, { resultSets: [set([[1]])] })], 0);
    const snapshot = structuredClone(before);
    const after = applyQueryEvents(before, [statement(1, 2, { error: "boom", resultSets: [set([[2]])] }), { type: "done", durationMs: 1 }], 0);
    expect(before).toEqual(snapshot);
    expect(after.results.length).toBe(2);
    expect(applyTimed(before, [])).toBe(before);
  });
});

describe("a run that broke off on this side", () => {
  it("ends with the reason, timed by the browser, and says nothing finished", () => {
    const run = failQueryRun(applyQueryEvents(begin({ startedAt: 1_000 }), [{ type: "running", index: 0 }], 1_100), "Connection is readonly", 1_250.4);
    expect(run).toMatchObject({ done: true, failed: true, running: null, durationMs: 250 });
    expect(run.messages.at(-1)).toEqual({ id: 1, level: "error", text: "Connection is readonly", time: 1_250.4 });
  });

  it("leaves a run that is over alone", () => {
    const done = applyQueryEvents(begin(), [{ type: "done", durationMs: 1 }], 0);
    expect(failQueryRun(done, "late", 9)).toBe(done);
  });
});

describe("after the run", () => {
  const run = applyQueryEvents(begin(), [
    statement(0, 1, { resultSets: [set([[1]])] }),
    statement(1, 2, { resultSets: [set([[2]]), set([[3]])] }),
  ], 0);

  it("finds a tab's result and statement", () => {
    expect(resultOfTab(run, run.tabs[2]!)).toEqual({ result: run.results[1]!, set: set([[3]]) });
    expect(resultOfTab(run, { key: "9:0", title: "x", statement: 9, set: 0 })).toBeNull();
  });

  it("replaces only that tab's rows with the ones read again", () => {
    const next = replaceResultSet(run, "1:1", set([[30]]));
    expect(next.results[1]!.resultSets).toEqual([set([[2]]), set([[30]])]);
    expect(next.results[0]).toBe(run.results[0]);
    expect(run.results[1]!.resultSets[1]).toEqual(set([[3]]));
    expect(replaceResultSet(run, "7:0", set([]))).toBe(run);
  });

  it("adds a line to Messages", () => {
    const next = noteOnQueryRun(run, { level: "warning", text: "Saved; reading the rows again failed" }, 99);
    expect(next.messages.at(-1)).toEqual({ id: run.messages.length, level: "warning", text: "Saved; reading the rows again failed", time: 99 });
    expect(run.messages.length).toBe(next.messages.length - 1);
  });
});

describe("the tab shown", () => {
  const empty = begin();
  const withResults = applyQueryEvents(begin(), [statement(0, 1, { resultSets: [set([[1]])] }), statement(1, 2, { resultSets: [set([[1]])] })], 0);

  it("is Messages until a result arrives, then the first result", () => {
    expect(shownResultTab(null, null)).toBe(MESSAGES_TAB);
    expect(shownResultTab(empty, null)).toBe(MESSAGES_TAB);
    expect(shownResultTab(withResults, null)).toBe("0:0");
  });

  it("stays the one picked while it exists — Messages included", () => {
    expect(shownResultTab(withResults, "1:0")).toBe("1:0");
    expect(shownResultTab(withResults, MESSAGES_TAB)).toBe(MESSAGES_TAB);
    expect(shownResultTab(withResults, "5:0")).toBe("0:0");
    expect(shownResultTab(empty, "0:0")).toBe(MESSAGES_TAB);
  });
});

describe("whether a result can be edited", () => {
  const col = (name: string, pk = false): DbColumnInfo => ({ name, type: "text", nullable: !pk, pk, defaultValue: null, autoIncrement: false });
  const users = [col("id", true), col("email"), col("name")];
  const base = { readonly: false, explain: false, table: { table: "users", schema: "" }, tableColumns: users, columns: ["email", "id"] };

  it("is, by the table's primary key, with the table's columns in the result's order", () => {
    expect(resultEditability(base)).toEqual({ editable: true, rowKey: ["id"], schema: [users[1]!, users[0]!] });
    const pair = [col("a", true), col("b", true), col("c")];
    expect(resultEditability({ ...base, tableColumns: pair, columns: ["c", "b", "a"] })).toMatchObject({ editable: true, rowKey: ["a", "b"] });
  });

  it("is not, and says why", () => {
    const reason = (over: Partial<typeof base> & { tableColumns?: DbColumnInfo[] | null | undefined }) => {
      const answer = resultEditability({ ...base, ...over });
      return answer.editable ? "editable" : answer.reason;
    };
    expect(reason({ readonly: true })).toBe("read-only connection");
    expect(reason({ explain: true })).toBe("read-only: a plan");
    expect(reason({ table: null })).toBe("read-only: not a single table");
    expect(reason({ tableColumns: undefined })).toBeNull();
    expect(reason({ tableColumns: null })).toBe("read-only: the table's columns could not be read");
    expect(reason({ tableColumns: [], columns: [] })).toBe("read-only: not a single table");
    expect(reason({ columns: ["id", "email", "email"] })).toBe("read-only: a column name repeats");
    expect(reason({ columns: ["id", "upper(email)"] })).toBe("read-only: not every column is the table's");
    expect(reason({ tableColumns: [col("id"), col("email")], columns: ["id"] })).toBe("read-only: no primary key");
    expect(reason({ columns: ["email", "name"] })).toBe("read-only: the primary key is not in the result");
  });
});

describe("countOf", () => {
  it("counts in English, with the thousands grouped", () => {
    expect(countOf(1, "row")).toBe("1 row");
    expect(countOf(0, "row")).toBe("0 rows");
    expect(countOf(12_345, "statement")).toBe("12,345 statements");
  });
});

describe("stopTitle", () => {
  it("says SQLite cannot stop the statement already running, where a server can", () => {
    expect(stopTitle("sqlite")).toBe("Stop before the next statement: SQLite cannot stop the one already running");
    for (const dialect of ["postgres", "mysql", undefined] as const) {
      expect(stopTitle(dialect)).toBe("Stop the statement running; the ones after it do not run");
    }
  });
});

describe("refusedAsReadonly", () => {
  it("offers a run with write access after a readonly connection refused one, or a wrong password did", () => {
    const refused = "Connection is readonly — only SELECT queries allowed. Change this in PPM web UI.";
    expect(refusedAsReadonly(failQueryRun(begin(), refused, 2_000))).toBe(true);
    expect(refusedAsReadonly(failQueryRun(begin(), "Wrong password", 2_000))).toBe(true);
    // The database itself refused a write that read as a read.
    const byDatabase = applyQueryEvents(begin(), [
      statement(0, 1, { error: "Connection is readonly — the database refused a write: cannot execute nextval() in a read-only transaction" }),
      { type: "done", durationMs: 9 },
    ], 2_000);
    expect(refusedAsReadonly(byDatabase)).toBe(true);
    expect(refusedAsReadonly(failQueryRun(begin(), "no such column: nosuch", 2_000))).toBe(false);
    expect(refusedAsReadonly(begin())).toBe(false);
  });
});
