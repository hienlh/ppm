/**
 * GET /api/chat/sessions/status against a real trace database and a real ppm.db in a scratch
 * PPM_HOME: a cancelled session, a finished and unanswered one, and one migrated to a new id,
 * plus a timing check over 300 sessions. A pending question lives only in the chat socket's
 * memory, so it is covered by the service's unit test rather than here.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const home = mkdtempSync(resolve(tmpdir(), "ppm-status-route-"));
process.env.PPM_HOME = home;

const { _resetPpmDir } = await import("../../src/services/ppm-dir.ts");
_resetPpmDir();
const db = await import("../../src/services/db.service.ts");
db.setDb(db.openTestDb());
const { closeTraceDb } = await import("../../src/services/session-trace/session-trace-db.ts");
const { appendBatch, recordTraceAlias } = await import("../../src/services/session-trace/session-trace-store.ts");
const { chatGlobalRoutes } = await import("../../src/server/routes/chat-global.ts");

const NOW = Date.now();

function writeTrace(traceId: string, events: Array<{ type: string; at: number; [k: string]: unknown }>): void {
  appendBatch(events.map(({ at, ...event }) => ({
    traceId, turnId: "t", ts: at, source: event.type === "user_message" || event.type === "turn_aborted" ? "server" : "agent",
    origin: "ws", providerId: "claude", refId: null, type: event.type, payloadJson: JSON.stringify(event),
  } as Parameters<typeof appendBatch>[0][number])));
}

function session(id: string, title: string): void {
  db.setSessionMetadata(id, "ppm", home);
  db.setSessionProvider(id, "claude");
  db.setSessionTitle(id, title);
}

async function status(query = "") {
  const res = await chatGlobalRoutes.request(`/sessions/status${query}`);
  return { status: res.status, body: await res.json() as { ok: boolean; data: any; error?: string } };
}

beforeAll(() => {
  db.upsertProject(home, "ppm");

  // Finished, never answered.
  session("idle-done", "Idle and done");
  writeTrace("idle-done", [
    { type: "user_message", at: NOW - 6 * 3_600_000, text: "go" },
    { type: "text", at: NOW - 6 * 3_600_000 + 10 },
    { type: "done", at: NOW - 5 * 3_600_000 },
  ]);
  db.incrementSessionUnread("idle-done", "done", "Idle and done", "ppm");

  // Stopped by the user mid-turn.
  session("cancelled", "Cancelled one");
  writeTrace("cancelled", [
    { type: "user_message", at: NOW - 60_000, text: "go" },
    { type: "tool_use", at: NOW - 50_000 },
    { type: "turn_aborted", at: NOW - 40_000, reason: "ws_cancel" },
    { type: "done", at: NOW - 39_000 },
  ]);

  // Traced under its first id, then renamed by the provider.
  session("codex-new", "Migrated one");
  db.setSessionMigratedTo("codex-old", "codex-new");
  recordTraceAlias("codex-new", "codex-old");
  writeTrace("codex-old", [
    { type: "user_message", at: NOW - 30_000, text: "q" },
    { type: "done", at: NOW - 20_000 },
    { type: "user_message", at: NOW - 10_000, text: "thanks" },
    { type: "done", at: NOW - 5_000 },
  ]);

  // A session in a project PPM does not have.
  db.setSessionMetadata("orphan", "deleted-project", "/nowhere");
  writeTrace("orphan", [{ type: "user_message", at: NOW - 1000, text: "x" }, { type: "done", at: NOW - 900 }]);

  // Too old for the default window.
  session("ancient", "Ancient");
  writeTrace("ancient", [{ type: "user_message", at: NOW - 400 * 3_600_000, text: "x" }, { type: "done", at: NOW - 400 * 3_600_000 + 5 }]);
});

afterAll(() => {
  closeTraceDb();
  try { rmSync(home, { recursive: true, force: true }); } catch { /* sqlite handles may linger on Windows */ }
});

describe("GET /api/chat/sessions/status", () => {
  it("lists the window's sessions in registered projects, newest first, with how each turn ended", async () => {
    const { status: code, body } = await status();
    expect(code).toBe(200);
    const sessions = body.data.sessions as any[];
    expect(sessions.map((s) => s.sessionId)).toEqual(["codex-new", "cancelled", "idle-done"]);

    const [migrated, cancelled, idle] = sessions;
    expect(cancelled).toMatchObject({
      projectName: "ppm", providerId: "claude", title: "Cancelled one", phase: "idle", pending: null,
      lastTurn: { outcome: "cancelled", at: new Date(NOW - 40_000).toISOString() },
    });
    expect(idle).toMatchObject({
      title: "Idle and done", unreadType: "done", userRepliedSinceAnswer: false,
      lastTurn: { outcome: "done", at: new Date(NOW - 5 * 3_600_000).toISOString() },
      lastAnswerAt: new Date(NOW - 5 * 3_600_000).toISOString(),
      updatedAt: new Date(NOW - 5 * 3_600_000).toISOString(),
    });
    expect(migrated).toMatchObject({ title: "Migrated one", lastTurn: { outcome: "done" }, userRepliedSinceAnswer: false });
  });

  it("narrows to one project, and widens the window to include older sessions", async () => {
    expect((await status("?project=other")).body.data.sessions).toEqual([]);
    const wide = await status("?sinceHours=2160");
    expect((wide.body.data.sessions as any[]).map((s) => s.sessionId)).toContain("ancient");
  });

  it("refuses a sinceHours outside 1 to 2160", async () => {
    for (const q of ["?sinceHours=0", "?sinceHours=2161", "?sinceHours=abc", "?sinceHours=1.5"]) {
      expect((await status(q)).status).toBe(400);
    }
  });

  it("answers 300 sessions quickly", async () => {
    for (let i = 0; i < 300; i++) {
      const id = `bulk-${i}`;
      db.setSessionMetadata(id, "ppm", home);
      writeTrace(id, [
        { type: "user_message", at: NOW - 100_000 + i, text: "x" },
        { type: "text", at: NOW - 99_000 + i },
        { type: "tool_use", at: NOW - 98_000 + i },
        { type: "done", at: NOW - 97_000 + i },
      ]);
    }
    await status(); // warm the lazy imports
    const started = performance.now();
    const { body } = await status();
    const ms = performance.now() - started;
    expect((body.data.sessions as any[]).length).toBeGreaterThanOrEqual(303);
    console.log(`sessions/status: ${body.data.sessions.length} sessions in ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(150);
  });
});
