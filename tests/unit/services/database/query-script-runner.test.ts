/**
 * The Query tab's run loop on a scripted session: which statements run, what each one reports,
 * where an error points, and what Stop, a timeout, a readonly refusal, a lost connection and a
 * transaction left open do to the rest of the run.
 */
import { describe, expect, it } from "bun:test";
import { QueryScriptRun, ROLLED_BACK_OPEN_TRANSACTION, type QueryScriptOptions } from "../../../../src/services/database/query-script-runner.ts";
import { QueryStatementError, ReadonlyViolationError } from "../../../../src/services/database/db-errors.ts";
import type { QueryScriptEvent, QueryStatementResult } from "../../../../src/shared/db-query-script.ts";
import type { SqlLexOptions } from "../../../../src/shared/split-sql-statements.ts";
import type { DbQuerySession, DbStatementOutcome } from "../../../../src/types/database.ts";

type Step = (sql: string, maxRows: number, session: FakeSession) => Promise<DbStatementOutcome>;

const rows = (...values: unknown[]): DbStatementOutcome => ({
  resultSets: [{ columns: [{ name: "v", type: "int" }], rows: values.map((v) => [v]), truncated: false }], notices: [],
});
const wrote = (n: number): DbStatementOutcome => ({ resultSets: [], rowsAffected: n, command: "UPDATE", notices: [] });

class FakeSession implements DbQuerySession {
  sent: string[] = [];
  cancels = 0;
  closes = 0;
  rollbacks = 0;
  openTransaction = false;
  private onCancel: (() => void) | null = null;

  constructor(private readonly step: Step, readonly splitOptions: SqlLexOptions = {}) {}

  run(sql: string, maxRows: number): Promise<DbStatementOutcome> {
    this.sent.push(sql);
    return this.step(sql, maxRows, this);
  }

  /** A statement that runs until cancelled, then ends the way `then` says. */
  untilCancelled(then: () => DbStatementOutcome | Error): Promise<DbStatementOutcome> {
    return new Promise((resolve, reject) => {
      this.onCancel = () => {
        const end = then();
        if (end instanceof Error) reject(end);
        else resolve(end);
      };
    });
  }

  cancel(): void {
    this.cancels++;
    const fire = this.onCancel;
    this.onCancel = null;
    fire?.();
  }

  async rollbackOpenTransaction(): Promise<boolean> {
    this.rollbacks++;
    const was = this.openTransaction;
    this.openTransaction = false;
    return was;
  }

  async close(): Promise<void> {
    this.closes++;
  }
}

async function run(session: FakeSession, options: Partial<QueryScriptOptions> & { sql: string }, during?: (r: QueryScriptRun) => void) {
  const events: QueryScriptEvent[] = [];
  const runner = new QueryScriptRun({ dialect: "postgres", maxRows: 100, ...options });
  during?.(runner);
  const summary = await runner.execute(session, (e) => events.push(e));
  const results = events.flatMap((e) => (e.type === "statement" ? [e.result] : []));
  return { events, summary, results, runner };
}

const pick = (r: QueryStatementResult) => ({ index: r.index, error: r.error, stopped: r.stopped });

/** Keeps the thread for `ms`, the way a SQLite statement does. */
function holdThread(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) { /* the thread is the engine's */ }
}

/** How many timers `work` sets. */
async function timersSetBy(work: () => Promise<unknown>): Promise<number> {
  let timers = 0;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => { timers++; return realSetTimeout(...args); }) as typeof setTimeout;
  try {
    await work();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  return timers;
}

describe("QueryScriptRun", () => {
  it("runs each statement in order and reports it as it ends, with the script's lines", async () => {
    const session = new FakeSession(async (sql) => (sql.startsWith("UPDATE") ? wrote(2) : rows(1, 2)));
    const { events, summary } = await run(session, { sql: "SELECT 1;\n\nUPDATE t\n  SET a = 1;\n-- last\nSELECT 2" });
    expect(session.sent).toEqual(["SELECT 1", "UPDATE t\n  SET a = 1", "-- last\nSELECT 2"]);
    expect(events.map((e) => e.type)).toEqual(["start", "running", "statement", "running", "statement", "running", "statement", "done"]);
    expect(events[0]).toEqual({ type: "start", statements: [{ startLine: 1, endLine: 1 }, { startLine: 3, endLine: 4 }, { startLine: 6, endLine: 6 }] });
    const [first, second, third] = events.flatMap((e) => (e.type === "statement" ? [e.result] : []));
    expect(first).toMatchObject({ index: 0, startLine: 1, endLine: 1, sql: "SELECT 1", resultSets: [{ columns: [{ name: "v", type: "int" }], rows: [[1], [2]] }] });
    expect(first!.resultSets[0]!.truncated).toBeUndefined();
    expect(second).toMatchObject({ index: 1, command: "UPDATE", rowsAffected: 2, resultSets: [] });
    expect(third).toMatchObject({ index: 2, startLine: 6 });
    expect(summary).toEqual({ status: "ok", rowCount: 6, lastResult: { columns: [{ name: "v", type: "int" }], rows: [[1], [2]] } });
    expect(session.closes).toBe(1);
    expect(session.rollbacks).toBe(1);
  });

  it("splits the script the way the session's server reads it", async () => {
    const session = new FakeSession(async () => rows(1), { backslashEscapes: false });
    await run(session, { sql: "SELECT 'a\\'; SELECT 2", dialect: "mysql" });
    expect(session.sent).toEqual(["SELECT 'a\\'", "SELECT 2"]);
  });

  it("hands the run's row limit to every statement and keeps what was cut", async () => {
    const limits: number[] = [];
    const session = new FakeSession(async (_sql, maxRows) => {
      limits.push(maxRows);
      return { resultSets: [{ columns: [], rows: [[1]], truncated: true }], notices: ["NOTICE: hi"] };
    });
    const { results } = await run(session, { sql: "SELECT 1; SELECT 2", maxRows: 10 });
    expect(limits).toEqual([10, 10]);
    expect(results[0]).toMatchObject({ resultSets: [{ truncated: true }], notices: ["NOTICE: hi"] });
  });

  it("stops at the first statement that fails, and goes on past it when asked", async () => {
    const step: Step = async (sql) => {
      if (sql === "BAD") throw new QueryStatementError("syntax error at or near \"BAD\"", { position: 1 });
      return rows(1);
    };
    const stopped = await run(new FakeSession(step), { sql: "SELECT 1;\nBAD;\nSELECT 3" });
    expect(stopped.results.map(pick)).toEqual([
      { index: 0, error: undefined, stopped: undefined },
      { index: 1, error: "syntax error at or near \"BAD\"", stopped: undefined },
    ]);
    expect(stopped.results[1]!.errorLine).toBe(2);
    expect(stopped.summary).toMatchObject({ status: "error", error: "syntax error at or near \"BAD\"" });
    const onward = await run(new FakeSession(step), { sql: "SELECT 1;\nBAD;\nSELECT 3", continueOnError: true });
    expect(onward.results.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(onward.summary.status).toBe("error");
  });

  it("turns where the server says an error is into a line of the script", async () => {
    const sql = "SELECT 1;\n\n-- why\nSELECT id,\n  statuss\nFROM t;\nSELECT x\nFROMM t";
    const session = new FakeSession(async (text) => {
      if (text.includes("statuss")) throw new QueryStatementError("column statuss", { position: text.indexOf("statuss") + 1 });
      if (text.includes("FROMM")) throw new QueryStatementError("near FROMM at line 2", { line: 2 });
      return rows(1);
    });
    const { results } = await run(session, { sql, continueOnError: true });
    expect(results.map((r) => r.errorLine)).toEqual([undefined, 5, 8]);
    const nowhere = await run(new FakeSession(async () => { throw new QueryStatementError("lost"); }), { sql: "SELECT 1" });
    expect(nowhere.results[0]!.errorLine).toBeUndefined();
  });

  it("cancels the statement running on Stop and starts no other, whatever continue-on-error says", async () => {
    const session = new FakeSession(async (sql, _max, s) => (
      sql === "SELECT pg_sleep(30)" ? s.untilCancelled(() => new QueryStatementError("canceling statement due to user request")) : rows(1)
    ));
    const pending = run(session, { sql: "SELECT 1; SELECT pg_sleep(30); SELECT 3", continueOnError: true }, (runner) => {
      setTimeout(() => runner.stop(), 20);
    });
    const { results, summary } = await pending;
    expect(results.map(pick)).toEqual([
      { index: 0, error: undefined, stopped: undefined },
      { index: 1, error: "canceling statement due to user request", stopped: "user" },
    ]);
    expect(session.sent).toEqual(["SELECT 1", "SELECT pg_sleep(30)"]);
    expect(session.cancels).toBe(1);
    expect(summary.status).toBe("error");
    expect(session.closes).toBe(1);
  });

  it("marks a statement the server ended successfully on Stop as stopped, keeping what it returned", async () => {
    const session = new FakeSession(async (sql, _max, s) => (sql === "SELECT SLEEP(30)" ? s.untilCancelled(() => rows(1)) : rows(2)));
    const { results, summary } = await run(session, { sql: "SELECT SLEEP(30); SELECT 2", dialect: "mysql" }, (runner) => {
      setTimeout(() => runner.stop(), 20);
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ stopped: "user", resultSets: [{ rows: [[1]] }] });
    expect(results[0]!.error).toBeUndefined();
    expect(summary).toMatchObject({ status: "error", error: "Stopped" });
  });

  it("lets a Stop sent during a statement that holds the thread land before the next one, as SQLite's do", async () => {
    // A statement run on this thread: nothing else runs until it ends, and the server reads a Stop
    // request that came meanwhile a few ms after that.
    let stop = () => {};
    const session = new FakeSession(async (sql) => {
      if (sql === "SELECT slow") {
        holdThread(150);
        setTimeout(stop, 5);
      }
      return rows(1);
    });
    const { results } = await run(session, { sql: "SELECT slow; SELECT 2; SELECT 3", dialect: "sqlite" }, (runner) => {
      stop = () => runner.stop();
    });
    expect(session.sent).toEqual(["SELECT slow"]);
    expect(results.map(pick)).toEqual([{ index: 0, error: undefined, stopped: "user" }]);
  });

  it("adds up the time statements hold the thread, so a run of short ones lets a Stop in too", async () => {
    const session = new FakeSession(async () => {
      holdThread(40);
      return rows(1);
    });
    const { results } = await run(session, { sql: "SELECT 1; SELECT 2; SELECT 3; SELECT 4; SELECT 5", dialect: "sqlite" }, (runner) => {
      setTimeout(() => runner.stop(), 0);
    });
    // 40 ms apiece: the third takes the run past the limit, and the Stop lands before the fourth.
    expect(session.sent).toEqual(["SELECT 1", "SELECT 2", "SELECT 3"]);
    expect(results.at(-1)?.stopped).toBe("user");
  });

  it("pauses once each time the limit is reached, not after every statement from then on", async () => {
    const session = new FakeSession(async (sql) => {
      holdThread(sql === "SELECT slow" ? 150 : 0);
      return rows(1);
    });
    const sql = ["SELECT slow", ...Array.from({ length: 20 }, (_, i) => `SELECT ${i}`)].join(";");
    expect(await timersSetBy(() => run(session, { sql, dialect: "sqlite" }))).toBe(1);
  });

  it("does not pause between statements that leave the thread free", async () => {
    const sql = Array.from({ length: 50 }, (_, i) => `SELECT ${i}`).join(";");
    expect(await timersSetBy(() => run(new FakeSession(async () => rows(1)), { sql }))).toBe(0);
  });

  it("does not count the time a statement waits on a server over the network", async () => {
    // Bun.sleep, not setTimeout: the timers counted are the runner's alone.
    const session = new FakeSession(async () => {
      await Bun.sleep(60);
      return rows(1);
    });
    expect(await timersSetBy(() => run(session, { sql: "SELECT 1; SELECT 2; SELECT 3" }))).toBe(0);
  });

  it("runs nothing after a Stop that came before the run", async () => {
    const session = new FakeSession(async () => rows(1));
    const { events } = await run(session, { sql: "SELECT 1; SELECT 2" }, (runner) => runner.stop());
    expect(session.sent).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(["start", "done"]);
    expect(session.closes).toBe(1);
  });

  it("cancels a statement that outruns the connection's timeout, and goes on only when asked", async () => {
    const step: Step = async (sql, _max, s) => (
      sql === "SLOW" ? s.untilCancelled(() => new QueryStatementError("canceling statement due to user request")) : rows(1)
    );
    const first = await run(new FakeSession(step), { sql: "SLOW; SELECT 2", timeoutMs: 30 });
    expect(first.results.map(pick)).toEqual([
      { index: 0, error: "Stopped after the connection's query timeout (0.03 s): canceling statement due to user request", stopped: "timeout" },
    ]);
    const onward = await run(new FakeSession(step), { sql: "SLOW; SELECT 2", timeoutMs: 30, continueOnError: true });
    expect(onward.results.map((r) => r.stopped)).toEqual(["timeout", undefined]);
    const quick = new FakeSession(async () => rows(1));
    await run(quick, { sql: "SELECT 1", timeoutMs: 10 });
    await new Promise((r) => setTimeout(r, 30));
    expect(quick.cancels).toBe(0);
  });

  it("reports a readonly refusal as blocked, in the words the rest of PPM uses", async () => {
    const refusal = new ReadonlyViolationError();
    const session = new FakeSession(async () => {
      throw new QueryStatementError(refusal.message, {}, refusal);
    });
    const { results, summary } = await run(session, { sql: "DELETE FROM t" });
    expect(results[0]!.error).toBe(refusal.message);
    expect(summary).toMatchObject({ status: "blocked", error: refusal.message });
    const byServer = new FakeSession(async (sql) => {
      if (sql === "SELECT 1") return rows(1);
      const cause = Object.assign(new Error("cannot execute nextval() in a read-only transaction"), { code: "25006" });
      throw new QueryStatementError(cause.message, {}, cause);
    });
    const second = await run(byServer, { sql: "SELECT 1; SELECT nextval('s')" });
    expect(second.results[1]!.error).toBe("Connection is readonly — the database refused a write: cannot execute nextval() in a read-only transaction");
    expect(second.summary.status).toBe("blocked");
  });

  it("gives up on a lost connection even when asked to go on, and does not try to roll back on it", async () => {
    const session = new FakeSession(async (sql) => {
      if (sql === "SELECT 2") throw new QueryStatementError("Connection terminated", {}, undefined, true);
      return rows(1);
    });
    const { results } = await run(session, { sql: "SELECT 1; SELECT 2; SELECT 3", continueOnError: true });
    expect(results.map((r) => r.index)).toEqual([0, 1]);
    expect(session.rollbacks).toBe(0);
    expect(session.closes).toBe(1);
  });

  it("rolls back a transaction the script left open, and says so", async () => {
    const session = new FakeSession(async (sql, _max, s) => {
      if (sql === "BEGIN") s.openTransaction = true;
      return wrote(0);
    });
    const { events, summary } = await run(session, { sql: "BEGIN; UPDATE t SET a = 1" });
    expect(events.at(-2)).toEqual({ type: "message", level: "error", text: ROLLED_BACK_OPEN_TRANSACTION });
    expect(events.at(-1)!.type).toBe("done");
    expect(summary).toMatchObject({ status: "error", error: ROLLED_BACK_OPEN_TRANSACTION });
  });

  it("puts the engine's EXPLAIN in front of each statement, and refuses one that would run under it", async () => {
    const pg = new FakeSession(async () => rows("Seq Scan"));
    await run(pg, { sql: "SELECT 1", explain: true });
    expect(pg.sent).toEqual(["EXPLAIN SELECT 1"]);
    const lite = new FakeSession(async () => rows("SCAN t"));
    await run(lite, { sql: "SELECT * FROM t", dialect: "sqlite", explain: true });
    expect(lite.sent).toEqual(["EXPLAIN QUERY PLAN SELECT * FROM t"]);
    const refused = new FakeSession(async () => rows(1));
    const { results } = await run(refused, { sql: "-- a plan\nANALYSE DELETE FROM t", explain: true });
    expect(refused.sent).toEqual([]);
    expect(results[0]!.error).toBe("This statement is already an EXPLAIN, ANALYZE or DESCRIBE: run it instead");
  });

  it("points an explained statement's error at the script, not at the EXPLAIN in front of it", async () => {
    const session = new FakeSession(async (sql) => {
      throw new QueryStatementError("column x", { position: sql.indexOf("x FROM") + 1 });
    });
    const { results } = await run(session, { sql: "\nSELECT a,\n x FROM t", explain: true });
    expect(results[0]!.errorLine).toBe(3);
  });

  it("wraps an error that is not a statement's own, and reports a broken run in its last line", async () => {
    const session = new FakeSession(async () => {
      throw new TypeError("boom");
    });
    const { results } = await run(session, { sql: "SELECT 1" });
    expect(results[0]!.error).toBe("boom");
    const broken = new FakeSession(async () => rows(1));
    broken.rollbackOpenTransaction = async () => { throw new Error("gone"); };
    const { events, summary } = await run(broken, { sql: "SELECT 1" });
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect((events.at(-1) as { error?: string }).error).toBeUndefined();
    expect(summary.status).toBe("ok");
  });
});
