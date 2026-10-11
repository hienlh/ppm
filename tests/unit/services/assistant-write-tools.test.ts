/**
 * The Assistant's calls that change something run only with the user's approval: a declined
 * or unanswered card runs nothing, a read-only connection or one taken away from the AI is never
 * written to — not even when that changed while the card waited — every statement is audited as
 * the agent's, and a message is sent into a chat in exactly the mode its card stated.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertConnection, openTestDb, setDb, setSessionAssistant, setSessionMetadata, updateConnection } from "../../../src/services/db.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { initAdapters } from "../../../src/services/database/init-adapters.ts";
import { getAdapter } from "../../../src/services/database/adapter-registry.ts";
import { getAuditDb } from "../../../src/services/query-audit/query-audit-db.ts";
import { listQueryLogs } from "../../../src/services/query-audit/query-audit.service.ts";
import { _setClaudeProjectsRoot } from "../../../src/services/agent-transcript/claude-projects-root.ts";
import { dbQuery } from "../../../src/services/assistant-mcp/assistant-db-tools.ts";
import { chatSendMessage, TARGET_HAS_PENDING_APPROVAL, type AssistantChatDelivery } from "../../../src/services/assistant-mcp/assistant-chat-send.ts";
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

describe("chat_send_message", () => {
  let root: string;
  let savedProjects: unknown;
  const SESSION = "0b6f6a3c-1a7b-4d7e-9b1a-2f0f6d8e9c11";
  const ASSISTANT_SESSION = "1c7a7b4d-2b8c-4e8f-8c2b-3a1a7e9f0d22";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ppm-asst-send-"));
    const project = join(root, "api");
    mkdirSync(project, { recursive: true });
    const claudeRoot = join(root, "claude-projects");
    const dir = join(claudeRoot, project.replace(/[/\\:.]/g, "-"));
    mkdirSync(dir, { recursive: true });
    for (const id of [SESSION, ASSISTANT_SESSION]) writeFileSync(join(dir, `${id}.jsonl`), '{"type":"user"}\n');
    _setClaudeProjectsRoot(claudeRoot);
    savedProjects = configService.get("projects");
    configService.set("projects", [{ name: "api", path: project }]);
  });
  afterAll(() => {
    _setClaudeProjectsRoot(null);
    configService.set("projects", savedProjects as never);
    rmSync(root, { recursive: true, force: true });
  });

  function fakeChat(state: { mode: string; source: "running" | "stored" | "live" | "provider-default"; pendingApproval: boolean }) {
    const sent: Array<{ target: unknown; text: string; mode: string }> = [];
    const delivery: AssistantChatDelivery = {
      inspect: () => state,
      deliver: async (target, t, mode) => { sent.push({ target, text: t, mode }); return { ok: true, sessionId: target.sessionId }; },
    };
    return { sent, delivery };
  }

  it("sends only once approved, in the mode the card stated", async () => {
    const chat = fakeChat({ mode: "bypassPermissions", source: "stored", pendingApproval: false });
    const { ask, asked } = asker(APPROVE);
    const args = { project: "api", sessionId: SESSION, text: "run the tests", reason: "this is routine, no need to read it closely" };
    const result = await chatSendMessage(args, ask, { delivery: chat.delivery, title: () => "Fix login" });
    expect(JSON.parse(text(result))).toMatchObject({ sent: true, project: "api", sessionId: SESSION, permissionMode: "bypassPermissions" });
    expect(chat.sent).toEqual([{ target: { sessionId: SESSION, projectName: "api", providerId: "claude" }, text: "run the tests", mode: "bypassPermissions" }]);
    const card = asked[0]!.summary;
    expect(card.body?.text).toBe("run the tests");
    expect(card.warning).toContain("without asking");
    expect(card.facts).toContainEqual({ label: "Mode from", value: "the mode saved for this chat" });
    // What the agent said about its own request is nowhere on the card.
    expect(JSON.stringify(asked[0])).not.toContain("routine");
  });

  it("sends nothing when the user declines or does not answer", async () => {
    for (const verdict of [DENY, TIMEOUT]) {
      const chat = fakeChat({ mode: "default", source: "provider-default", pendingApproval: false });
      const result = await chatSendMessage({ project: "api", sessionId: SESSION, text: "deploy" }, asker(verdict).ask, { delivery: chat.delivery, title: () => null });
      expect(result.isError).toBe(true);
      expect(JSON.parse(text(result)).note).toContain("final");
      expect(chat.sent).toHaveLength(0);
    }
  });

  it("refuses a chat waiting on its own approval, without asking", async () => {
    const chat = fakeChat({ mode: "default", source: "stored", pendingApproval: true });
    const { ask, asked } = asker(APPROVE);
    const result = await chatSendMessage({ project: "api", sessionId: SESSION, text: "go on" }, ask, { delivery: chat.delivery });
    expect(text(result)).toBe(TARGET_HAS_PENDING_APPROVAL);
    expect(asked).toHaveLength(0);
    expect(chat.sent).toHaveLength(0);
  });

  it("refuses an Assistant chat and a chat of another project", async () => {
    setSessionMetadata(ASSISTANT_SESSION, "__assistant__", "/somewhere");
    setSessionAssistant(ASSISTANT_SESSION);
    const chat = fakeChat({ mode: "default", source: "stored", pendingApproval: false });
    const { ask, asked } = asker(APPROVE);
    expect(text(await chatSendMessage({ project: "api", sessionId: ASSISTANT_SESSION, text: "hi" }, ask, { delivery: chat.delivery }))).toContain("PPM Assistant chat");
    expect(text(await chatSendMessage({ project: "api", sessionId: "2d8b8c5e-3c9d-4f90-9d3c-4b2b8f0a1e33", text: "hi" }, ask, { delivery: chat.delivery }))).toContain("is not a chat of project");
    expect(text(await chatSendMessage({ project: "nope", sessionId: SESSION, text: "hi" }, ask, { delivery: chat.delivery }))).toContain("No registered project");
    expect(asked).toHaveLength(0);
    expect(chat.sent).toHaveLength(0);
  });

  it("says when the chat refused the message after the approval", async () => {
    const chat = fakeChat({ mode: "default", source: "stored", pendingApproval: false });
    chat.delivery.deliver = async () => ({ ok: false, error: "The chat would now run in \"plan\"" });
    const result = await chatSendMessage({ project: "api", sessionId: SESSION, text: "hi" }, asker(APPROVE).ask, { delivery: chat.delivery });
    expect(text(result)).toStartWith("Not sent:");
  });
});
