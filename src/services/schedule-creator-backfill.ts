/**
 * Which chat owns a schedule made before `schedules.created_by_session_id` existed, read back from
 * the session trace (`session-trace.db`), so a chat's footer chip also lists the script and prompt
 * schedules its AI made earlier (migrations 80 and 82, and `ppm schedule owners`).
 *
 * A chat's AI creates a script or prompt schedule through one of three tools, and each answers
 * `{ "created": true, "schedule": { "id": N, "name": ... } }`: the session tool
 * `session_schedule_propose_script`, and the PPM Assistant's `schedule_propose_script` and
 * `schedule_save`. The trace keeps the call (`tool_use`, with the tool's name) and its answer
 * (`tool_result`) under the chat's trace id, which is the id the chat started with. Claude's
 * answers are stored as the MCP content array they came in, `[{"type":"text","text":"{...}"}]`,
 * as a JSON string — reading that as the object itself is why migration 80 linked nothing.
 *
 * Only a match PPM can stand behind is written: the answer names the schedule's id *and* its name,
 * and the call came within a few minutes of the row's `created_at`. The trace file is shared by
 * every database in the PPM folder (a dev `ppm.dev.db` beside `ppm.db`), so an id alone could name
 * another database's schedule. When the schedule's script reports to one other chat of its project
 * (`schedule-delivery-chat.ts`), that chat owns it rather than the one that happened to propose it.
 * Anything unreadable is skipped; the column then stays null, as for a schedule made in Settings.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { deliveryChatOf } from "./schedule-delivery-chat.ts";

/** The tools whose answer creates a script or prompt schedule, by the name after the server prefix. */
const CREATING_TOOLS = ["session_schedule_propose_script", "schedule_propose_script", "schedule_save"] as const;

/** How far the call may be from the row's `created_at` (the card waits for the user in between). */
const MATCH_WINDOW_MS = 15 * 60_000;

interface UnlinkedRow { id: number; name: string; created_at: string; project_path: string; inputs_json: string | null; input_values_json: string | null }

/** Why a chat is named as a schedule's owner. */
export type OwnerReason = "creator" | "delivers-to";

/** One schedule the trace can give an owner, and which chat that would be. */
export interface ScheduleOwnerPlan {
  id: number;
  name: string;
  /** The chat that will own it. */
  sessionId: string;
  reason: OwnerReason;
  /** The chat whose tool call created it (equal to `sessionId` when `reason` is "creator"). */
  creator: string;
}

/** `mcp__ppm-sessions__session_schedule_propose_script` / `ppm_sessions.x` / `x` → `x`. */
export function bareToolName(tool: string): string {
  return tool.split(/__|\./).pop() ?? tool;
}

/** The schedule a creating tool's answer reports, or null when the answer created nothing. */
export function createdScheduleOf(output: string): { id: number; name: string | null } | null {
  const parsed = parseJsonObject(output);
  if (parsed) {
    const schedule = parsed.schedule as Record<string, unknown> | undefined;
    if (parsed.created !== true || !schedule || !Number.isSafeInteger(schedule.id)) return null;
    return { id: schedule.id as number, name: typeof schedule.name === "string" ? schedule.name : null };
  }
  return null;
}

/** The text of an MCP content array (`[{type:"text",text}]`), or null when `v` is not one. */
function contentArrayText(v: unknown[]): string | null {
  const texts = v.flatMap((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text"
    && typeof (b as { text?: unknown }).text === "string" ? [(b as { text: string }).text] : []));
  return texts.length > 0 ? texts.join("\n") : null;
}

/** The JSON object in a tool's output: the whole text, an MCP content array's text, or the first `{...}` inside a wrapper. */
function parseJsonObject(text: string, depth = 0): Record<string, unknown> | null {
  if (depth > 3) return null;
  for (const candidate of [text, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)]) {
    if (!candidate) continue;
    try {
      const v = JSON.parse(candidate) as unknown;
      // Claude's MCP answers are stored as the content array they arrived in. Checked before the
      // `{...}` slice below, which would otherwise find the array's first block and stop there.
      if (Array.isArray(v)) {
        const inner = contentArrayText(v);
        if (inner !== null) return parseJsonObject(inner, depth + 1);
        continue;
      }
      if (v && typeof v === "object") return v as Record<string, unknown>;
      // A provider may hand the text over as a JSON string of the text.
      if (typeof v === "string") return parseJsonObject(v, depth + 1);
    } catch { /* try the next form */ }
  }
  return null;
}

/** SQLite's `datetime('now')` text (UTC, no zone) as epoch milliseconds. */
function sqliteUtcMs(text: string): number {
  return Date.parse(`${text.replace(" ", "T")}Z`);
}

/**
 * Which chat the trace at `tracePath` says should own each script and prompt schedule that has no
 * owner yet. Writes nothing; answers an empty list when there is nothing to read. Never throws.
 */
export function planScheduleOwners(db: Database, tracePath: string, warn: (m: string) => void = () => {}): ScheduleOwnerPlan[] {
  let trace: Database | null = null;
  try {
    const unlinked = db.query(
      `SELECT id, name, created_at, project_path, inputs_json, input_values_json FROM schedules
       WHERE created_by_session_id IS NULL AND kind IN ('script', 'prompt')`,
    ).all() as UnlinkedRow[];
    if (unlinked.length === 0 || !existsSync(tracePath)) return [];
    trace = new Database(tracePath, { readonly: true });
    trace.exec("PRAGMA busy_timeout = 2000");
    const hasEvents = trace.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_events'").get();
    if (!hasEvents) return [];

    const rowsById = new Map(unlinked.map((r) => [r.id, r]));
    // Only events from around the oldest unlinked schedule on: the `ts` index keeps this a range
    // read rather than a scan of a trace that may hold months of chats.
    const since = Math.min(...unlinked.map((r) => sqliteUtcMs(r.created_at)).filter(Number.isFinite)) - MATCH_WINDOW_MS;
    const calls = trace.query(
      `SELECT trace_id, ts, payload_json FROM session_events
       WHERE ts >= ? AND type = 'tool_use' AND payload_json LIKE '%schedule_%'`,
    ).all(Number.isFinite(since) ? since : 0) as { trace_id: string; ts: number; payload_json: string }[];
    const resultOf = trace.query(
      `SELECT payload_json FROM session_events
       WHERE trace_id = ? AND type = 'tool_result' AND ts >= ? AND json_extract(payload_json, '$.toolUseId') = ?
       LIMIT 1`,
    );

    const plans: ScheduleOwnerPlan[] = [];
    for (const call of calls) {
      let payload: { tool?: unknown; toolUseId?: unknown };
      try { payload = JSON.parse(call.payload_json); } catch { continue; }
      if (typeof payload.tool !== "string" || typeof payload.toolUseId !== "string") continue;
      if (!(CREATING_TOOLS as readonly string[]).includes(bareToolName(payload.tool))) continue;
      const answer = resultOf.get(call.trace_id, call.ts, payload.toolUseId) as { payload_json: string } | null;
      if (!answer) continue;
      let output: unknown;
      try { output = (JSON.parse(answer.payload_json) as { output?: unknown }).output; } catch { continue; }
      if (typeof output !== "string") continue;
      const created = createdScheduleOf(output);
      const row = created ? rowsById.get(created.id) : undefined;
      if (!created || !row || created.name !== row.name) continue;
      const createdAt = sqliteUtcMs(row.created_at);
      if (!Number.isFinite(createdAt) || Math.abs(createdAt - call.ts) > MATCH_WINDOW_MS) continue;
      const delivers = deliveryChatOf(db, row);
      const owner = delivers && delivers !== call.trace_id ? delivers : call.trace_id;
      plans.push({ id: row.id, name: row.name, sessionId: owner, reason: owner === call.trace_id ? "creator" : "delivers-to", creator: call.trace_id });
      rowsById.delete(row.id);
    }
    return plans.sort((a, b) => a.id - b.id);
  } catch (e) {
    warn(`schedule owners were not read back from the session trace: ${(e as Error)?.message ?? e}`);
    return [];
  } finally {
    trace?.close();
  }
}

/**
 * Writes the owners `plans` name, only into rows that still have none, and tells `info` about each
 * one written. Answers how many rows it filled; never throws.
 */
export function applyScheduleOwners(db: Database, plans: ScheduleOwnerPlan[], info: (m: string) => void = () => {}, warn: (m: string) => void = () => {}): number {
  try {
    const update = db.query(
      "UPDATE schedules SET created_by_session_id = ? WHERE id = ? AND created_by_session_id IS NULL AND kind IN ('script', 'prompt')",
    );
    let filled = 0;
    for (const p of plans) {
      if (update.run(p.sessionId, p.id).changes === 0) continue;
      filled++;
      const via = p.reason === "creator" ? "created it" : `reports to it; created by ${p.creator.slice(0, 8)}`;
      info(`schedule #${p.id} "${p.name}" → chat ${p.sessionId} (${via})`);
    }
    return filled;
  } catch (e) {
    warn(`schedule owners were not written: ${(e as Error)?.message ?? e}`);
    return 0;
  }
}

/** `planScheduleOwners` then `applyScheduleOwners`: how many schedules got an owner. Never throws. */
export function backfillScheduleCreators(
  db: Database, tracePath: string, warn: (m: string) => void = () => {}, info: (m: string) => void = () => {},
): number {
  return applyScheduleOwners(db, planScheduleOwners(db, tracePath, warn), info, warn);
}
