/**
 * Schedules made before `created_by_session_id` existed are linked to the chat that made them
 * from the session trace, and only where the trace names the schedule's id, its name and a time
 * close to its creation (the trace file is shared by every database in the PPM folder).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION, openTestDb, runMigrations, setDb } from "../../../src/services/db.service.ts";
import { getSchedule, insertSchedule } from "../../../src/services/scheduler-db.service.ts";
import { backfillScheduleCreators, bareToolName, createdScheduleOf } from "../../../src/services/schedule-creator-backfill.ts";

let dir: string;
let tracePath: string;
let db: Database;

function traceDb(): Database {
  const t = new Database(tracePath);
  t.exec(`
    CREATE TABLE IF NOT EXISTS session_events (
      trace_id TEXT NOT NULL, seq INTEGER NOT NULL, turn_id TEXT, ts INTEGER NOT NULL, source TEXT NOT NULL,
      origin TEXT NOT NULL, provider_id TEXT, ref_id TEXT, type TEXT NOT NULL, payload_json TEXT NOT NULL,
      PRIMARY KEY (trace_id, seq)
    );
  `);
  return t;
}

let seq = 0;
/** One tool call and its answer, as the trace recorder stores them. */
function recordCall(t: Database, traceId: string, tool: string, answer: unknown, ts: number): void {
  const id = `toolu_${++seq}`;
  const add = t.query("INSERT INTO session_events (trace_id, seq, ts, source, origin, type, payload_json) VALUES (?, ?, ?, 'agent', 'user', ?, ?)");
  add.run(traceId, ++seq, ts, "tool_use", JSON.stringify({ type: "tool_use", tool, input: {}, toolUseId: id }));
  add.run(traceId, ++seq, ts + 2000, "tool_result", JSON.stringify({ type: "tool_result", output: JSON.stringify(answer, null, 1), toolUseId: id }));
}

function script(name: string): number {
  return insertSchedule({
    name, cron_expr: "0 3 * * *", provider_id: "claude", project_path: "/tmp/p", prompt: "",
    kind: "script", script: "export default async () => {}",
  });
}

/** The row's `created_at` as epoch ms (SQLite writes UTC without a zone). */
const createdMs = (id: number) => Date.parse(`${getSchedule(id)!.created_at.replace(" ", "T")}Z`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ppm-backfill-"));
  tracePath = join(dir, "session-trace.db");
  db = openTestDb();
  setDb(db);
});

afterEach(() => {
  db.close();
  // A database file `runMigrations` opened stays locked on Windows after close (statements it
  // prepared are not finalized); the temp folder is left to the OS then.
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* EBUSY on Windows */ }
});

describe("backfillScheduleCreators", () => {
  it("links a script schedule to the chat whose propose_script call created it", () => {
    const id = script("Hourly sync");
    const t = traceDb();
    recordCall(t, "90412fcb-0000-4000-8000-000000000001", "mcp__ppm-sessions__session_schedule_propose_script",
      { created: true, schedule: { id, name: "Hourly sync", kind: "script" } }, createdMs(id) - 60_000);
    t.close();

    expect(backfillScheduleCreators(db, tracePath)).toBe(1);
    expect(getSchedule(id)!.created_by_session_id).toBe("90412fcb-0000-4000-8000-000000000001");
  });

  it("reads the PPM Assistant's schedule_save and a Codex-style tool name too", () => {
    const a = insertSchedule({ name: "Digest", cron_expr: "0 8 * * *", provider_id: "claude", project_path: "/tmp/p", prompt: "sum up" });
    const b = script("Watch CI");
    const t = traceDb();
    recordCall(t, "assistant-chat-0001", "mcp__ppm-assistant__schedule_save", { created: true, schedule: { id: a, name: "Digest" } }, createdMs(a));
    recordCall(t, "codex-chat-0002", "ppm_sessions.session_schedule_propose_script", { created: true, schedule: { id: b, name: "Watch CI" } }, createdMs(b));
    t.close();

    expect(backfillScheduleCreators(db, tracePath)).toBe(2);
    expect(getSchedule(a)!.created_by_session_id).toBe("assistant-chat-0001");
    expect(getSchedule(b)!.created_by_session_id).toBe("codex-chat-0002");
  });

  it("writes nothing for an answer that names another schedule, a refusal, a far-off time or another tool", () => {
    const id = script("Hourly sync");
    const t = traceDb();
    const at = createdMs(id);
    // Same id, other name: another database's schedule in the shared trace.
    recordCall(t, "chat-name", "mcp__ppm-sessions__session_schedule_propose_script", { created: true, schedule: { id, name: "Other" } }, at);
    recordCall(t, "chat-refused", "mcp__ppm-sessions__session_schedule_propose_script", { done: false, outcome: "denied" }, at);
    recordCall(t, "chat-late", "mcp__ppm-sessions__session_schedule_propose_script", { created: true, schedule: { id, name: "Hourly sync" } }, at + 3 * 3600_000);
    recordCall(t, "chat-tool", "mcp__ppm-sessions__session_schedule_list", { created: true, schedule: { id, name: "Hourly sync" } }, at);
    t.close();

    expect(backfillScheduleCreators(db, tracePath)).toBe(0);
    expect(getSchedule(id)!.created_by_session_id).toBeNull();
  });

  it("leaves a schedule already linked, and does nothing without a trace file", () => {
    const id = insertSchedule({
      name: "Hourly sync", cron_expr: "0 3 * * *", provider_id: "claude", project_path: "/tmp/p", prompt: "",
      kind: "script", script: "export default async () => {}", created_by_session_id: "chat-first",
    });
    expect(backfillScheduleCreators(db, tracePath)).toBe(0);
    const t = traceDb();
    recordCall(t, "chat-second", "mcp__ppm-sessions__session_schedule_propose_script", { created: true, schedule: { id, name: "Hourly sync" } }, createdMs(id));
    t.close();
    expect(backfillScheduleCreators(db, tracePath)).toBe(0);
    expect(getSchedule(id)!.created_by_session_id).toBe("chat-first");
  });

  it("never throws on a broken trace file", async () => {
    script("Hourly sync");
    await Bun.write(tracePath, "not a database");
    const warnings: string[] = [];
    expect(backfillScheduleCreators(db, tracePath, (m) => warnings.push(m))).toBe(0);
    expect(warnings).toHaveLength(1);
  });
});

describe("migration 80", () => {
  it("reads the creators back from the trace beside the database file it upgrades", () => {
    const file = new Database(join(dir, "ppm.db"));
    runMigrations(file);
    setDb(file);
    const id = script("Hourly sync");
    const t = traceDb();
    recordCall(t, "90412fcb-0000-4000-8000-000000000002", "mcp__ppm-sessions__session_schedule_propose_script",
      { created: true, schedule: { id, name: "Hourly sync" } }, createdMs(id));
    t.close();
    // A database one step behind: the step adds nothing new but reads the trace.
    file.exec("PRAGMA user_version = 79");
    runMigrations(file);
    expect(getSchedule(id)!.created_by_session_id).toBe("90412fcb-0000-4000-8000-000000000002");
    expect((file.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(CURRENT_SCHEMA_VERSION);
    setDb(db);
    file.close();
  });
});

describe("parsing", () => {
  it("strips the server prefix from a tool name", () => {
    expect(bareToolName("mcp__ppm-sessions__session_schedule_propose_script")).toBe("session_schedule_propose_script");
    expect(bareToolName("ppm_sessions.schedule_save")).toBe("schedule_save");
    expect(bareToolName("schedule_save")).toBe("schedule_save");
  });

  it("reads the created schedule from a plain or wrapped answer", () => {
    expect(createdScheduleOf(JSON.stringify({ created: true, schedule: { id: 116, name: "x" } }))).toEqual({ id: 116, name: "x" });
    expect(createdScheduleOf(`Result: ${JSON.stringify({ created: true, schedule: { id: 7, name: "y" } })}`)).toEqual({ id: 7, name: "y" });
    expect(createdScheduleOf(JSON.stringify({ created: false }))).toBeNull();
    expect(createdScheduleOf("Not created: refused")).toBeNull();
  });
});
