/**
 * An approved UPDATE or DELETE answers with the rows it changed as they were before: read by a
 * SELECT of the same table and WHERE, on the same connection, in the same transaction, just
 * before the write. Only the plain single-table shape is read that way; anything PPM cannot name
 * safely — another table joined in, a cut set, a WHERE that answers differently a moment later, a
 * function that is not a plain read — runs as typed and says its old values were not captured.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertConnection, openTestDb, setDb, updateConnection } from "../../../src/services/db.service.ts";
import { initAdapters } from "../../../src/services/database/init-adapters.ts";
import { getAdapter } from "../../../src/services/database/adapter-registry.ts";
import { getAuditDb } from "../../../src/services/query-audit/query-audit-db.ts";
import { listQueryLogs } from "../../../src/services/query-audit/query-audit.service.ts";
import { dbQuery } from "../../../src/services/assistant-mcp/assistant-db-tools.ts";
import { isUpdateOrDelete, writeTargetSelect } from "../../../src/services/assistant-mcp/assistant-sql-write-target.ts";
import { MAX_OLD_ROWS, planOldRows } from "../../../src/services/assistant-mcp/assistant-write-old-rows.ts";
import type { AskApproval } from "../../../src/services/assistant-mcp/assistant-approval-broker.ts";
import type { DbQuerySession } from "../../../src/types/database.ts";

const CALLER = { actor: "agent" as const, callerIp: null, callerUa: "PPM Assistant (session test)" };
const APPROVE: AskApproval = async () => ({ verdict: "approved" });
const body = (r: Record<string, unknown>) => JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as Record<string, any>;

describe("which rows an UPDATE or DELETE changes", () => {
  it("is a SELECT of the same table and WHERE for the plain single-table shape", () => {
    expect(writeTargetSelect("UPDATE items SET name = 'x', qty = qty + 1 WHERE id = 1", "sqlite"))
      .toEqual({ ok: true, kind: "update", selectSql: "SELECT * FROM items WHERE id = 1" });
    expect(writeTargetSelect("DELETE FROM public.\"Order Items\" AS o WHERE o.qty < 3 AND o.note <> 'WHERE x'", "postgres"))
      .toEqual({ ok: true, kind: "delete", selectSql: "SELECT * FROM public.\"Order Items\" AS o WHERE o.qty < 3 AND o.note <> 'WHERE x'" });
    expect(writeTargetSelect("update `shop`.`orders` o set o.qty = 0 where o.id in (select id from archived where gone)", "mysql"))
      .toEqual({ ok: true, kind: "update", selectSql: "SELECT * FROM `shop`.`orders` o WHERE o.id in (select id from archived where gone)" });
    // No WHERE: every row of the table.
    expect(writeTargetSelect("DELETE FROM items;", "sqlite")).toEqual({ ok: true, kind: "delete", selectSql: "SELECT * FROM items" });
    // A subquery's FROM, a string or a comment that looks like a keyword changes nothing.
    expect(writeTargetSelect("UPDATE t SET a = (SELECT max(b) FROM u) /* FROM x */ WHERE c = 'LIMIT 1'", "postgres"))
      .toMatchObject({ ok: true, selectSql: "SELECT * FROM t WHERE c = 'LIMIT 1'" });
  });

  it("is not identified for any other shape", () => {
    for (const [sql, dialect] of [
      ["UPDATE t SET a = 1 FROM u WHERE t.id = u.id", "postgres"],
      ["DELETE FROM t USING u WHERE t.id = u.id", "postgres"],
      ["UPDATE t1, t2 SET t1.a = t2.a WHERE t1.id = t2.id", "mysql"],
      ["UPDATE t1 JOIN t2 ON t1.id = t2.id SET t1.a = 1", "mysql"],
      ["DELETE t1 FROM t1 JOIN t2 ON t1.id = t2.id", "mysql"],
      ["UPDATE t SET a = 1 ORDER BY id LIMIT 1", "mysql"],
      ["DELETE FROM t WHERE id IN (SELECT id FROM t LIMIT 3)", "sqlite"],
      ["UPDATE ONLY t SET a = 1", "postgres"],
      ["UPDATE OR REPLACE t SET a = 1", "sqlite"],
      ["UPDATE LOW_PRIORITY t SET a = 1", "mysql"],
      ["DELETE FROM t WHERE CURRENT OF c", "postgres"],
      ["DELETE FROM t WHERE id = 1 RETURNING *", "postgres"],
      ["WITH x AS (SELECT 1) UPDATE t SET a = 1", "postgres"],
      ["UPDATE t SET a = 1; DELETE FROM t", "sqlite"],
      ["INSERT INTO t VALUES (1)", "sqlite"],
      ["UPDATE t SET a = 1 WHERE", "sqlite"],
    ] as const) {
      expect(writeTargetSelect(sql, dialect).ok).toBe(false);
    }
    // MySQL's text is read both ways a backslash may read on the server.
    expect(writeTargetSelect("UPDATE t SET a = 'x\\' WHERE b = 1 -- '", "mysql").ok).toBe(false);
  });

  it("tells an UPDATE or DELETE from any other statement", () => {
    expect(isUpdateOrDelete("/* note */ update t set a = 1", "postgres")).toBe(true);
    expect(isUpdateOrDelete("DELETE FROM t", "sqlite")).toBe(true);
    expect(isUpdateOrDelete("INSERT INTO t VALUES (1)", "sqlite")).toBe(false);
  });

  it("is not read first when the read would not be a plain one, or might name other rows a moment later", () => {
    expect(planOldRows("DELETE FROM t WHERE expires < now()", "postgres").ok).toBe(true);
    for (const [sql, dialect] of [
      ["DELETE FROM t WHERE expires < now()", "mysql"],
      ["DELETE FROM t WHERE created < datetime('now')", "sqlite"],
      ["DELETE FROM t WHERE random() < 0.5", "postgres"],
      ["UPDATE t SET a = 1 WHERE CURRENT_TIMESTAMP > b", "sqlite"],
      ["DELETE FROM t WHERE my_func(id)", "postgres"],
      ["DELETE FROM t WHERE id = pg_terminate_backend(1)", "postgres"],
    ] as const) {
      const plan = planOldRows(sql, dialect);
      expect(plan.ok).toBe(false);
    }
  });
});

describe("an approved UPDATE or DELETE on SQLite", () => {
  const dirs: string[] = [];
  const spies: Array<{ mockRestore(): void }> = [];
  let path = "";
  let conn = 0;
  const rows = (sql: string) => {
    const db = new Database(path, { readonly: true });
    try { return db.query(sql).all(); } finally { db.close(); }
  };

  beforeEach(() => {
    initAdapters();
    setDb(openTestDb());
    getAuditDb().exec("DELETE FROM query_log");
    const dir = mkdtempSync(join(tmpdir(), "ppm-asst-old-rows-"));
    dirs.push(dir);
    path = join(dir, "data.db");
    const db = new Database(path);
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, qty INTEGER)");
    for (let i = 1; i <= 5; i++) db.exec(`INSERT INTO items (id, name, qty) VALUES (${i}, 'item ${i}', ${i * 10})`);
    db.close();
    conn = insertConnection("sqlite", "main", { type: "sqlite", path }).id;
    updateConnection(conn, { readonly: 0 });
  });
  afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });
  afterAll(() => {
    for (const dir of dirs) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite handle */ } }
  });

  /** Records every statement the query sessions run, in order. */
  function recordSessions(): string[] {
    const ran: string[] = [];
    const adapter = getAdapter("sqlite");
    const open = adapter.openQuerySession.bind(adapter);
    const spy = spyOn(adapter, "openQuerySession").mockImplementation(async (config) => {
      const session = await open(config);
      const recorded: DbQuerySession = { ...session, run: (text, maxRows) => { ran.push(text); return session.run(text, maxRows); } };
      return recorded;
    });
    spies.push(spy);
    return ran;
  }

  it("answers an UPDATE with the changed rows as they were, read in the write's own transaction", async () => {
    const ran = recordSessions();
    const result = await dbQuery({ connectionId: conn, sql: "UPDATE items SET qty = 0, name = 'gone' WHERE id IN (2, 4)" }, CALLER, APPROVE);
    expect(result.isError).toBeUndefined();
    const answer = body(result);
    expect(answer).toMatchObject({
      connection: "main", rowsAffected: 2, columns: ["id", "name", "qty"],
      oldRows: [[2, "item 2", 20], [4, "item 4", 40]], oldRowsCapped: false,
    });
    expect(ran).toEqual(["BEGIN IMMEDIATE", "SELECT * FROM items WHERE id IN (2, 4)", "UPDATE items SET qty = 0, name = 'gone' WHERE id IN (2, 4)", "COMMIT"]);
    expect(rows("SELECT name, qty FROM items WHERE id = 2")).toEqual([{ name: "gone", qty: 0 }]);
    // One audit entry, the write's; PPM's own read is not the agent's statement.
    expect(listQueryLogs({ connectionId: conn }).map((l) => [l.sql, l.status, l.actor])).toEqual([
      ["UPDATE items SET qty = 0, name = 'gone' WHERE id IN (2, 4)", "ok", "agent"],
    ]);
  });

  it("answers a DELETE with the deleted rows, and says when there were more than it lists", async () => {
    const db = new Database(path);
    for (let i = 6; i <= MAX_OLD_ROWS + 50; i++) db.exec(`INSERT INTO items (id, name, qty) VALUES (${i}, 'item ${i}', 1)`);
    db.close();
    const answer = body(await dbQuery({ connectionId: conn, sql: "DELETE FROM items" }, CALLER, APPROVE));
    expect(answer.rowsAffected).toBe(MAX_OLD_ROWS + 50);
    expect(answer.oldRows).toHaveLength(MAX_OLD_ROWS);
    expect(answer.oldRows[0]).toEqual([1, "item 1", 10]);
    expect(answer.oldRowsCapped).toBe(true);
    expect(answer.oldRowsCappedNote).toContain(`first ${MAX_OLD_ROWS}`);
    expect(rows("SELECT COUNT(*) AS n FROM items")).toEqual([{ n: 0 }]);
  });

  it("rolls the whole transaction back when the write fails", async () => {
    const ran = recordSessions();
    const result = await dbQuery({ connectionId: conn, sql: "UPDATE items SET name = NULL WHERE id = 1" }, CALLER, APPROVE);
    expect(result.isError).toBe(true);
    expect(ran.at(-1)).not.toBe("COMMIT");
    expect(rows("SELECT name FROM items WHERE id = 1")).toEqual([{ name: "item 1" }]);
    expect(listQueryLogs({ connectionId: conn })[0]).toMatchObject({ status: "error", actor: "agent" });
    // The file is not left locked by a transaction that never ended.
    expect(body(await dbQuery({ connectionId: conn, sql: "UPDATE items SET qty = 7 WHERE id = 1" }, CALLER, APPROVE)).rowsAffected).toBe(1);
  });

  it("runs any other UPDATE as typed, saying its old values were not captured", async () => {
    const ran = recordSessions();
    const answer = body(await dbQuery({ connectionId: conn, sql: "UPDATE items SET qty = 1 WHERE random() IS NULL" }, CALLER, APPROVE));
    expect(answer).toMatchObject({ rowsAffected: 0, oldRows: null });
    expect(answer.oldRowsNote).toContain("not captured");
    expect(answer.oldRowsNote).toContain("random");
    expect(ran).toEqual([]);
  });

  it("adds nothing about old values to a write that has none", async () => {
    const answer = body(await dbQuery({ connectionId: conn, sql: "INSERT INTO items (id, name) VALUES (99, 'new')" }, CALLER, APPROVE));
    expect(answer).toEqual({ connection: "main", rowsAffected: 1, executionTimeMs: answer.executionTimeMs });
  });
});
