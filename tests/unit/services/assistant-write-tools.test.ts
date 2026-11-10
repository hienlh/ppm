/**
 * The Assistant's calls that change something run only with the user's approval: a declined
 * or unanswered card runs nothing, a read-only connection or one taken away from the AI is never
 * written to — not even when that changed while the card waited — and every statement is audited
 * as the agent's. Messages into chats go through the session tools (`collab-assistant-caller.test.ts`).
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
import type { ApprovalAsk, ApprovalVerdict, AskApproval } from "../../../src/services/assistant-mcp/assistant-approval-broker.ts";

const CALLER = { actor: "agent" as const, callerIp: null, callerUa: "PPM Assistant (session test)" };
const text = (r: Record<string, unknown>) => (r.content as Array<{ text: string }>)[0]!.text;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

/** An asker that records each card and answers `verdict` (after `meanwhile`, when given). */
function asker(verdict: ApprovalVerdict, meanwhile?: () => void) {
  const asked: ApprovalAsk[] = [];
  const ask: AskApproval = async (a) => { asked.push(a); meanwhile?.(); return verdict; };
  return { asked, ask };
}
const APPROVE: ApprovalVerdict = { verdict: "approved" };
const DENY: ApprovalVerdict = { verdict: "denied", reason: "The user declined." };
const TIMEOUT: ApprovalVerdict = { verdict: "timeout", reason: "The user did not answer within 10 minutes." };

describe("db_query writes", () => {
  const dirs: string[] = [];
  let path = "";
  let writable = 0;
  let readonly = 0;
  const count = () => {
    const db = new Database(path, { readonly: true });
    try { return (db.query("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n; } finally { db.close(); }
  };

  beforeEach(() => {
    initAdapters();
    setDb(openTestDb());
    getAuditDb().exec("DELETE FROM query_log");
    const dir = mkdtempSync(join(tmpdir(), "ppm-asst-write-"));
    dirs.push(dir);
    path = join(dir, "data.db");
    const db = new Database(path);
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
    for (let i = 1; i <= 5; i++) db.exec(`INSERT INTO items (id, name) VALUES (${i}, 'item ${i}')`);
    db.close();
    writable = insertConnection("sqlite", "main", { type: "sqlite", path }).id;
    updateConnection(writable, { readonly: 0 });
    readonly = insertConnection("sqlite", "replica", { type: "sqlite", path }).id;
    updateConnection(readonly, { readonly: 1 });
  });
  afterAll(() => {
    for (const dir of dirs) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite handle */ } }
  });

  it("runs nothing when the user declines or does not answer, and audits the refusal", async () => {
    for (const verdict of [DENY, TIMEOUT]) {
      const { ask, asked } = asker(verdict);
      const result = await dbQuery({ connectionId: writable, sql: "DELETE FROM items WHERE id = 1" }, CALLER, ask);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("approval was not given");
      expect(asked[0]!.summary.body).toEqual({ label: "SQL", text: "DELETE FROM items WHERE id = 1", format: "sql" });
    }
    expect(count()).toBe(5);
    expect(listQueryLogs({ connectionId: writable }).map((l) => [l.status, l.actor])).toEqual([["blocked", "agent"], ["blocked", "agent"]]);
  });

  it("runs an approved write on a writable connection, says how many rows changed and what they held, and audits it as the agent's", async () => {
    const openSession = spyOn(getAdapter("sqlite"), "openQuerySession");
    spies.push(openSession);
    const { ask, asked } = asker(APPROVE);
    const result = await dbQuery({ connectionId: "main", sql: "DELETE FROM items WHERE id > 3" }, CALLER, ask);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(text(result))).toMatchObject({ connection: "main", rowsAffected: 2, oldRows: [[4, "item 4"], [5, "item 5"]] });
    expect(count()).toBe(3);
    expect((openSession.mock.calls[0]![0] as { readonly?: boolean }).readonly).toBeFalsy();
    expect(asked[0]!.summary.facts).toContainEqual({ label: "Connection", value: "main (sqlite)" });
    expect(listQueryLogs({ connectionId: writable })[0]).toMatchObject({ actor: "agent", status: "ok", caller_ua: CALLER.callerUa });
  });

  it("never writes through a read-only connection, and does not even ask", async () => {
    const { ask, asked } = asker(APPROVE);
    const result = await dbQuery({ connectionId: readonly, sql: "UPDATE items SET name = 'x'" }, CALLER, ask);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("read-only connection");
    expect(asked).toHaveLength(0);
    const db = new Database(path, { readonly: true });
    try { expect((db.query("SELECT COUNT(*) AS n FROM items WHERE name = 'x'").get() as { n: number }).n).toBe(0); } finally { db.close(); }
    expect(listQueryLogs({ connectionId: readonly })[0]).toMatchObject({ status: "blocked", actor: "agent" });
  });

  it("runs an approved read it could not prove safe down a read-only connection's read-only path", async () => {
    const runQuery = spyOn(getAdapter("sqlite"), "runQuery");
    spies.push(runQuery);
    const { ask, asked } = asker(APPROVE);
    const result = await dbQuery({ connectionId: readonly, sql: "SELECT changes() AS c" }, CALLER, ask);
    expect(result.isError).toBeUndefined();
    expect(asked).toHaveLength(1);
    expect((runQuery.mock.calls[0]![0] as { readonly?: boolean }).readonly).toBe(true);
  });

  it("writes nothing to a connection made read-only, or taken from the AI, while the card waited", async () => {
    const madeReadonly = asker(APPROVE, () => updateConnection(writable, { readonly: 1 }));
    expect(text(await dbQuery({ connectionId: writable, sql: "DELETE FROM items" }, CALLER, madeReadonly.ask))).toContain("made read-only");
    updateConnection(writable, { readonly: 0 });
    const takenAway = asker(APPROVE, () => updateConnection(writable, { aiAccess: 0 }));
    expect(text(await dbQuery({ connectionId: writable, sql: "DELETE FROM items" }, CALLER, takenAway.ask))).toContain("no longer available to the AI");
    expect(count()).toBe(5);
    expect(listQueryLogs({ connectionId: writable }).map((l) => l.status)).toEqual(["blocked", "blocked"]);
  });

  it("never opens a connection the user keeps from the AI", async () => {
    updateConnection(writable, { aiAccess: 0 });
    const { ask, asked } = asker(APPROVE);
    const result = await dbQuery({ connectionId: writable, sql: "DELETE FROM items" }, CALLER, ask);
    expect(text(result)).toContain("not available to the AI");
    expect(asked).toHaveLength(0);
    expect(count()).toBe(5);
  });
});

