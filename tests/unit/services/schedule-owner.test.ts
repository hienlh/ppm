/**
 * Who owns a script or prompt schedule (the chat whose footer chip lists it): the rule both doors
 * share (`ownerRefusal`), a chat claiming one nobody owns (`session_schedule_claim`), and the
 * person moving it in Settings (`PATCH /api/schedules/:id/owner`) or linking from the trace
 * (`GET`/`POST /api/schedules/owners`).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { openTestDb, setDb, setSessionMetadata, setSessionTitle } from "../../../src/services/db.service.ts";
import { getSchedule, insertSchedule } from "../../../src/services/scheduler-db.service.ts";
import { ownerRefusal } from "../../../src/services/schedule-owner.ts";
import { sessionScheduleToolCall, type SessionScheduleToolEnv } from "../../../src/services/session-collab/collab-schedules.ts";
import { AiScheduleNoticeLimit } from "../../../src/services/session-collab/collab-schedule-notice-limit.ts";
import type { ScheduleTargetDeps } from "../../../src/services/session-schedules/session-schedule-target.ts";
import { getTraceDbPath } from "../../../src/services/session-trace/session-trace-db.ts";
import { schedulesRoutes } from "../../../src/server/routes/schedules.ts";

const PROJECT = "/work/proj";
const CHAT_A = "chat-owner-aaaa";
const CHAT_B = "chat-owner-bbbb";
const FOREIGN = "chat-owner-zzzz";

const target: ScheduleTargetDeps = {
  canonical: (id) => id,
  stored: (id, read) => read(id),
  isDesign: () => false,
  isAssistant: () => false,
  hasClaudeTranscript: () => false,
  projectByPath: (p) => (p === PROJECT ? { name: "proj", path: PROJECT } : null),
  projectPath: (id) => (id === FOREIGN ? "/work/other" : id.startsWith("chat-owner-") ? PROJECT : null),
  provider: () => "claude",
};

let changes = 0;
const env = (): SessionScheduleToolEnv => ({
  target, changed: () => { changes++; }, now: () => new Date("2026-11-24T12:00:00Z"), localZone: () => "Europe/London",
  chatTitle: () => "A chat", notify: () => {}, noticeLimit: new AiScheduleNoticeLimit(),
});
type Result = { content: Array<{ text: string }>; isError?: boolean };
const claim = (chat: string, id: unknown) => sessionScheduleToolCall(env(), chat, "session_schedule_claim" as never, { id }) as Result;
const text = (r: Result) => r.content[0]!.text;

function schedule(name: string, opts: { project?: string; owner?: string; kind?: "script" | "prompt" } = {}): number {
  return insertSchedule({
    name, cron_expr: "*/5 * * * *", provider_id: "claude", project_path: opts.project ?? PROJECT, prompt: "p",
    kind: opts.kind ?? "script", script: "export default async () => {}", created_by_session_id: opts.owner ?? null,
  });
}

beforeEach(() => {
  setDb(openTestDb());
  changes = 0;
});

describe("ownerRefusal", () => {
  it("takes a chat of the schedule's project and refuses anything else", () => {
    const s = { kind: "script" as const, project_path: PROJECT };
    expect(ownerRefusal(s, CHAT_A, target)).toEqual({ ok: true, sessionId: CHAT_A });
    expect(ownerRefusal(s, FOREIGN, target)).toMatchObject({ ok: false, reason: expect.stringContaining("another project") });
    expect(ownerRefusal(s, "nope", target)).toMatchObject({ ok: false, reason: "That is not a chat id." });
    expect(ownerRefusal(s, "unknown-chat-1234", target)).toMatchObject({ ok: false, reason: "PPM has no record of that chat." });
    expect(ownerRefusal({ kind: "session", project_path: PROJECT }, CHAT_A, target).ok).toBe(false);
  });
});

describe("session_schedule_claim", () => {
  it("makes the calling chat the owner of a schedule nobody owns", () => {
    const id = schedule("slack-watch");
    const r = claim(CHAT_A, id);
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r))).toMatchObject({ claimed: true, id, name: "slack-watch" });
    expect(getSchedule(id)!.created_by_session_id).toBe(CHAT_A);
    expect(changes).toBe(1);
  });

  it("never takes a schedule another chat owns, and answers its own again without a change", () => {
    const id = schedule("review-queue-watch", { owner: CHAT_B });
    const r = claim(CHAT_A, id);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(CHAT_B);
    expect(getSchedule(id)!.created_by_session_id).toBe(CHAT_B);
    expect(JSON.parse(text(claim(CHAT_B, id)))).toMatchObject({ claimed: true, note: "This chat already owns it." });
    expect(changes).toBe(0);
  });

  it("treats another project's schedule, a session schedule and a missing id as not there", () => {
    const elsewhere = schedule("elsewhere", { project: "/work/other" });
    const missing = 9999;
    for (const id of [elsewhere, missing]) {
      const r = claim(CHAT_A, id);
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("This project has no script or prompt schedule");
    }
    expect(getSchedule(elsewhere)!.created_by_session_id).toBeNull();
    expect(claim(CHAT_A, "x").isError).toBe(true);
  });

  it("lets only the first of two chats win", () => {
    const id = schedule("prod-issue-watch", { kind: "prompt" });
    expect(claim(CHAT_A, id).isError).toBeFalsy();
    expect(claim(CHAT_B, id).isError).toBe(true);
    expect(getSchedule(id)!.created_by_session_id).toBe(CHAT_A);
  });

  it("lists each project schedule's owner", () => {
    const owned = schedule("owned", { owner: CHAT_B });
    const free = schedule("free");
    const list = JSON.parse(text(sessionScheduleToolCall(env(), CHAT_A, "session_schedule_list" as never, {}) as Result));
    const byId = Object.fromEntries(list.projectSchedules.map((s: { id: number; owner: string | null }) => [s.id, s.owner]));
    expect(byId).toEqual({ [owned]: CHAT_B, [free]: null });
  });
});

describe("PATCH /api/schedules/:id/owner", () => {
  const patch = (id: number, body: unknown) => schedulesRoutes.request(`/${id}/owner`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

  beforeEach(() => {
    for (const id of [CHAT_A, CHAT_B]) setSessionMetadata(id, "proj", PROJECT);
    setSessionMetadata(FOREIGN, "other", "/work/other");
  });

  it("moves a schedule to a chat of its project, and clears it with null", async () => {
    const id = schedule("review-queue-watch", { owner: CHAT_B });
    const res = await patch(id, { sessionId: CHAT_A });
    expect(res.status).toBe(200);
    expect(getSchedule(id)!.created_by_session_id).toBe(CHAT_A);
    expect((await patch(id, { sessionId: null })).status).toBe(200);
    expect(getSchedule(id)!.created_by_session_id).toBeNull();
  });

  it("refuses a chat of another project, a session schedule, a bad body and a missing schedule", async () => {
    const id = schedule("watch");
    const foreign = await patch(id, { sessionId: FOREIGN });
    expect(foreign.status).toBe(400);
    expect(((await foreign.json()) as { error: string }).error).toContain("another project");
    expect((await patch(id, { owner: CHAT_A })).status).toBe(400);
    expect((await patch(9999, { sessionId: CHAT_A })).status).toBe(404);
    const session = insertSchedule({
      name: "nudge", cron_expr: "0 9 * * *", provider_id: "claude", project_path: PROJECT, prompt: "p", kind: "session", target_session_id: CHAT_A,
    });
    expect((await patch(session, { sessionId: CHAT_B })).status).toBe(400);
    expect(getSchedule(id)!.created_by_session_id).toBeNull();
  });
});

describe("GET and POST /api/schedules/owners", () => {
  /** One claude propose_script call in the trace PPM reads, stored the way Claude's answers are. */
  function traceCreation(traceId: string, id: number, name: string): void {
    const t = new Database(getTraceDbPath());
    t.exec(`CREATE TABLE IF NOT EXISTS session_events (
      trace_id TEXT NOT NULL, seq INTEGER NOT NULL, turn_id TEXT, ts INTEGER NOT NULL, source TEXT NOT NULL,
      origin TEXT NOT NULL, provider_id TEXT, ref_id TEXT, type TEXT NOT NULL, payload_json TEXT NOT NULL,
      PRIMARY KEY (trace_id, seq))`);
    const at = Date.parse(`${getSchedule(id)!.created_at.replace(" ", "T")}Z`);
    const add = t.query("INSERT INTO session_events (trace_id, seq, ts, source, origin, type, payload_json) VALUES (?, ?, ?, 'agent', 'user', ?, ?)");
    const output = JSON.stringify([{ type: "text", text: JSON.stringify({ created: true, schedule: { id, name } }, null, 1) }]);
    add.run(traceId, 1, at, "tool_use", JSON.stringify({ type: "tool_use", tool: "mcp__ppm-sessions__session_schedule_propose_script", input: {}, toolUseId: "t1" }));
    add.run(traceId, 2, at + 1500, "tool_result", JSON.stringify({ type: "tool_result", output, toolUseId: "t1" }));
    t.close();
  }

  // Each test reads a trace of its own: the shared PPM folder's `session-trace.db` can still be held
  // open by a test file that ran earlier in the same process, and Windows refuses to delete it then.
  let savedPpmHome: string | undefined;
  let traceHome: string;

  beforeEach(() => {
    savedPpmHome = process.env.PPM_HOME;
    traceHome = mkdtempSync(join(tmpdir(), "ppm-schedule-owners-"));
    process.env.PPM_HOME = traceHome;
    _resetPpmDir();
    setSessionMetadata(CHAT_A, "proj", PROJECT);
    setSessionTitle(CHAT_A, "QL Slack");
  });

  afterEach(() => {
    if (savedPpmHome === undefined) delete process.env.PPM_HOME;
    else process.env.PPM_HOME = savedPpmHome;
    _resetPpmDir();
    try { rmSync(traceHome, { recursive: true, force: true }); } catch { /* EBUSY on Windows: left to the OS */ }
  });

  it("lists what it would link without writing, then links it", async () => {
    const id = schedule("slack-watch");
    traceCreation(CHAT_A, id, "slack-watch");

    const dry = await schedulesRoutes.request("/owners");
    expect(dry.status).toBe(200);
    const { data } = (await dry.json()) as { data: { dryRun: boolean; plans: unknown[] } };
    expect(data.dryRun).toBe(true);
    expect(data.plans).toEqual([{ id, name: "slack-watch", sessionId: CHAT_A, reason: "creator", creator: CHAT_A, ownerTitle: "QL Slack", creatorTitle: "QL Slack" }]);
    expect(getSchedule(id)!.created_by_session_id).toBeNull();

    const run = await schedulesRoutes.request("/owners", { method: "POST" });
    expect(((await run.json()) as { data: { linked: number } }).data.linked).toBe(1);
    expect(getSchedule(id)!.created_by_session_id).toBe(CHAT_A);
  });
});
