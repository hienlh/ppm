/**
 * `runApprovedScript` against a session that behaves as MySQL and MariaDB were measured to: a
 * CREATE, ALTER, DROP or TRUNCATE commits the open transaction before it runs — even when it then
 * fails — and itself after, and the session is back in autocommit until a transaction is opened
 * again. The same runs on the real servers are in tests/integration/db-ai-tools.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { runApprovedScript } from "../../../src/services/db-ai-tools/db-ai-run.ts";
import type { DbQuerySession, DbStatementOutcome } from "../../../src/types/database.ts";

const COMMITS_BY_ITSELF = /^(create|alter|drop|truncate)\b(?!\s+temporary)/i;

/**
 * `lose` drops the connection at the first statement containing `at`: during it (it fails, after a
 * CREATE, ALTER, DROP or TRUNCATE has committed what came before it), or `after` it has run. From
 * then on every call fails, and the server rolls back what is open, as it does when a client goes.
 */
function fakeSession(opts: { mysql: boolean; lose?: { at: string; after?: boolean } }) {
  let open = false;
  let closed = false;
  let lost = false;
  let pending: string[] = [];
  const committed: string[] = [];
  const sent: string[] = [];
  const commit = () => {
    committed.push(...pending);
    pending = [];
  };
  /** What the connection answers, once it has: nothing at all after `close()`, as mysql2's destroy. */
  const answer = async <T>(value: () => T): Promise<T> => {
    await Bun.sleep(1);
    if (lost) throw new Error("Connection lost: The server closed the connection.");
    return closed ? new Promise<T>(() => {}) : value();
  };
  const loseConnection = () => {
    lost = true;
    pending = [];
    open = false;
  };
  const session: DbQuerySession = {
    splitOptions: {},
    run: (sql) => answer((): DbStatementOutcome => {
      sent.push(sql);
      if (/^(begin|start transaction)$/i.test(sql)) {
        open = true;
        return { resultSets: [], notices: [] };
      }
      if (sql === "COMMIT") {
        commit();
        open = false;
        return { resultSets: [], notices: [] };
      }
      const selfCommits = opts.mysql && COMMITS_BY_ITSELF.test(sql);
      if (selfCommits) {
        commit();
        open = false;
      }
      const losing = opts.lose !== undefined && sql.includes(opts.lose.at);
      if (losing && !opts.lose!.after) {
        loseConnection();
        throw new Error("Connection lost: The server closed the connection.");
      }
      if (sql.includes("nosuch")) throw new Error("Table 'nosuch' doesn't exist");
      if (open) pending.push(sql);
      else committed.push(sql);
      if (losing) loseConnection();
      return { resultSets: [], notices: [], ...(/^(insert|update|delete)\b/i.test(sql) ? { rowsAffected: 1 } : {}) };
    }),
    cancel: () => {},
    rollbackOpenTransaction: () => answer(() => {
      const was = open;
      pending = [];
      open = false;
      return was;
    }),
    ...(opts.mysql ? { transactionOpen: () => answer(() => open) } : {}),
    close: async () => {
      closed = true;
    },
  };
  return { session, sent, committed };
}

const run = (session: DbQuerySession, sql: string, expectedRows?: number) =>
  runApprovedScript(session, { sql, dbType: "mysql", maxRows: 10, ...(expectedRows !== undefined ? { expectedRows } : {}) });

const BECAUSE = "because MySQL and MariaDB commit a CREATE, ALTER, DROP or TRUNCATE by itself, with everything before it.";
const LOST = "Connection lost: The server closed the connection.";
const ROLLBACK_FAILED = ` Rolling back failed too (${LOST}); the database ends the transaction when the connection closes.`;

describe("runApprovedScript on a database where a statement can commit by itself", () => {
  it("says the statements MySQL committed were kept when a later one fails", async () => {
    const { session, committed } = fakeSession({ mysql: true });
    const report = await run(session, "INSERT INTO a VALUES (1);\nCREATE TABLE b (id INT);\nINSERT INTO nosuch VALUES (1)");
    expect(report).toMatchObject({ committed: false, kept: 2 });
    expect(report.committed ? "" : report.reason).toBe(`Statement 3 failed, but nothing could be rolled back: statements 1–2 were kept, ${BECAUSE}`);
    expect(committed).toEqual(["INSERT INTO a VALUES (1)", "CREATE TABLE b (id INT)"]);
  });

  it("opens the transaction again after one, so what follows is rolled back", async () => {
    const { session, sent, committed } = fakeSession({ mysql: true });
    const report = await run(session, "CREATE TABLE b (id INT);\nINSERT INTO a VALUES (1);\nINSERT INTO a VALUES (2)", 3);
    expect(report).toMatchObject({ committed: false, kept: 1 });
    expect(report.committed ? "" : report.reason).toBe(
      `The script changed 2 rows in all, not the 3 expected, so statements 2–3 were rolled back, but statement 1 was kept, ${BECAUSE}`,
    );
    expect(committed).toEqual(["CREATE TABLE b (id INT)"]);
    expect(sent).toEqual(["START TRANSACTION", "CREATE TABLE b (id INT)", "START TRANSACTION", "INSERT INTO a VALUES (1)", "INSERT INTO a VALUES (2)"]);
  });

  it("counts what came before a statement that commits it and then fails", async () => {
    const { session, committed } = fakeSession({ mysql: true });
    const report = await run(session, "INSERT INTO a VALUES (1);\nALTER TABLE nosuch ADD c INT");
    expect(report).toMatchObject({ committed: false, kept: 1 });
    expect(report.committed ? "" : report.reason).toBe(`Statement 2 failed, but nothing could be rolled back: statement 1 was kept, ${BECAUSE}`);
    expect(committed).toEqual(["INSERT INTO a VALUES (1)"]);
  });

  it("says nothing changed when nothing did, a TEMPORARY table included", async () => {
    const { session, committed } = fakeSession({ mysql: true });
    const report = await run(session, "CREATE TEMPORARY TABLE t (id INT);\nINSERT INTO a VALUES (1);\nINSERT INTO nosuch VALUES (1)");
    expect(report).toMatchObject({ committed: false, kept: 0, reason: "Statement 3 failed, so the transaction was rolled back and nothing changed." });
    expect(committed).toEqual([]);
  });

  it("commits a script whose last statement committed itself", async () => {
    const { session, committed } = fakeSession({ mysql: true });
    const report = await run(session, "INSERT INTO a VALUES (1);\nCREATE TABLE b (id INT)", 1);
    expect(report).toMatchObject({ committed: true, rowsChanged: 1 });
    expect(committed).toEqual(["INSERT INTO a VALUES (1)", "CREATE TABLE b (id INT)"]);
  });
});

describe("runApprovedScript when the connection goes before the database can say what it kept", () => {
  it("says what came before a statement that commits by itself may have been kept", async () => {
    const { session, committed } = fakeSession({ mysql: true, lose: { at: "ALTER" } });
    const report = await run(session, "INSERT INTO a VALUES (1);\nALTER TABLE a ADD c INT");
    expect(report).toMatchObject({ committed: false, kept: 0, mayHaveKept: 1 });
    expect(report.committed ? "" : report.reason).toBe(
      `Statement 2 failed, and the database could not be asked what it kept: statement 1 may have been kept, ${BECAUSE}${ROLLBACK_FAILED}`,
    );
    expect(committed).toEqual(["INSERT INTO a VALUES (1)"]);
  });

  it("says a statement that commits by itself may have been kept with what came before it when it ran", async () => {
    const { session, committed } = fakeSession({ mysql: true, lose: { at: "CREATE", after: true } });
    const report = await run(session, "INSERT INTO a VALUES (1);\nCREATE TABLE b (id INT);\nINSERT INTO a VALUES (2)");
    expect(report).toMatchObject({ committed: false, kept: 0, mayHaveKept: 2 });
    expect(report.committed ? "" : report.reason).toBe(
      `The run broke off (${LOST}), and the database could not be asked what it kept: statements 1–2 may have been kept, ${BECAUSE}${ROLLBACK_FAILED}`,
    );
    expect(committed).toEqual(["INSERT INTO a VALUES (1)", "CREATE TABLE b (id INT)"]);
  });

  it("tells what it knows was kept from what may have been", async () => {
    const { session, committed } = fakeSession({ mysql: true, lose: { at: "DROP" } });
    const report = await run(session, "INSERT INTO a VALUES (1);\nCREATE TABLE b (id INT);\nINSERT INTO b VALUES (2);\nDROP TABLE c");
    expect(report).toMatchObject({ committed: false, kept: 2, mayHaveKept: 3 });
    expect(report.committed ? "" : report.reason).toBe(
      `Statement 4 failed, and the database could not be asked what it kept: statements 1–2 were kept, and statement 3 may have been kept too, ${BECAUSE}${ROLLBACK_FAILED}`,
    );
    expect(committed).toEqual(["INSERT INTO a VALUES (1)", "CREATE TABLE b (id INT)", "INSERT INTO b VALUES (2)"]);
  });

  it("still says nothing changed when the statement it lost could not have committed anything", async () => {
    const { session, committed } = fakeSession({ mysql: true, lose: { at: "UPDATE" } });
    const report = await run(session, "INSERT INTO a VALUES (1);\nUPDATE a SET b = 2");
    expect(report).toMatchObject({ committed: false, kept: 0 });
    expect(report.committed ? 0 : report.mayHaveKept).toBeUndefined();
    expect(report.committed ? "" : report.reason).toBe(`Statement 2 failed, so the transaction was rolled back and nothing changed.${ROLLBACK_FAILED}`);
    expect(committed).toEqual([]);
  });
});

describe("runApprovedScript where a transaction ends only when told to", () => {
  it("rolls all of it back and asks nothing more of the session", async () => {
    const { session, sent, committed } = fakeSession({ mysql: false });
    const report = await run(session, "INSERT INTO a VALUES (1);\nCREATE TABLE b (id INT);\nINSERT INTO nosuch VALUES (1)");
    expect(report).toMatchObject({ committed: false, kept: 0, reason: "Statement 3 failed, so the transaction was rolled back and nothing changed." });
    expect(committed).toEqual([]);
    expect(sent).toEqual(["START TRANSACTION", "INSERT INTO a VALUES (1)", "CREATE TABLE b (id INT)", "INSERT INTO nosuch VALUES (1)"]);
  });
});
