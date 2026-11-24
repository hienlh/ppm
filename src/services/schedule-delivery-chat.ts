/**
 * The chat a script schedule reports to, read from its inputs: the one input value (set, or the
 * input's default) that is the id of a chat PPM keeps of the schedule's own project. A watch built
 * by one chat and handed to another — review-queue-watch, made by the project's manager chat but
 * sending every report to the "QL Review PR" chat — belongs in the chip of the chat it talks to.
 *
 * Takes the database it reads from, because migrations run it before `getDb()` names one.
 */
import type { Database } from "bun:sqlite";
import { resolve } from "node:path";

const CHAT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DeliveryRow { project_path: string; inputs_json: string | null; input_values_json: string | null }

/** A folder in one spelling: resolved, and case-folded on Windows (`projectKey`, without the config it loads). */
export function folderKey(path: string): string {
  const abs = resolve(path);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

/** Every input value the schedule runs with: the value set for it, else the input's default. */
function effectiveInputValues(row: DeliveryRow): unknown[] {
  const decls = parseJson<unknown>(row.inputs_json, []);
  const values = parseJson<unknown>(row.input_values_json, {});
  const set = values && typeof values === "object" && !Array.isArray(values) ? values as Record<string, unknown> : {};
  const out = new Map<string, unknown>(Object.entries(set));
  if (Array.isArray(decls)) {
    for (const d of decls) {
      if (!d || typeof d !== "object") continue;
      const { key, default: def } = d as { key?: unknown; default?: unknown };
      if (typeof key === "string" && !out.has(key) && def !== undefined) out.set(key, def);
    }
  }
  return [...out.values()];
}

/** The project folder PPM recorded for a chat, or null when it recorded none. */
function chatFolder(db: Database, sessionId: string): string | null {
  try {
    const row = db.query("SELECT project_path FROM session_metadata WHERE session_id = ?").get(sessionId) as { project_path: string | null } | null;
    return row?.project_path ?? null;
  } catch {
    return null;
  }
}

/**
 * The one chat of the schedule's project its inputs name, or null when they name none, or more
 * than one (then nothing says which of them the schedule is for).
 */
export function deliveryChatOf(db: Database, row: DeliveryRow): string | null {
  const ids = new Set(effectiveInputValues(row).filter((v): v is string => typeof v === "string" && CHAT_ID_RE.test(v.trim())).map((v) => v.trim()));
  if (ids.size === 0) return null;
  const project = folderKey(row.project_path);
  const ours = [...ids].filter((id) => {
    const folder = chatFolder(db, id);
    return folder !== null && folderKey(folder) === project;
  });
  return ours.length === 1 ? ours[0]! : null;
}
