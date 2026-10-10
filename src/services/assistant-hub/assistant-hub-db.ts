import { getDb, resolveMigratedSession } from "../db.service.ts";

/**
 * Storage for the PPM Assistant on Telegram (tables from migration 58):
 *
 * - **bindings**: which Assistant session each Telegram chat talks to, one per chat.
 * - **watches**: "tell me when that chat finishes", kept across restarts, and kept after firing
 *   so a report the Assistant could not take at once can still be delivered.
 *
 * Session ids are stored as given and answered with the id the session goes by now: Codex
 * renames a session on its first turn, and a binding or watch made before that must still find
 * it. Lookups by session id compare current ids for the same reason.
 */

export interface TelegramBinding {
  telegramChatId: string;
  /** The Assistant session's current id. */
  sessionId: string;
  providerId: string;
  updatedAt: number;
}

export const WATCH_STATUSES = ["active", "fired", "cancelled", "expired"] as const;
export type WatchStatus = (typeof WATCH_STATUSES)[number];

export interface AssistantWatch {
  id: string;
  /** The Assistant session that asked, by its current id. */
  assistantSessionId: string;
  /** The watched chat, by its current id. */
  targetSessionId: string;
  targetProject: string;
  targetProvider: string;
  createdAt: number;
  expiresAt: number;
  /** The watched chat had a turn running when the watch was set. */
  armedRunning: boolean;
  status: WatchStatus;
  lastEvent: string | null;
  firedAt: number | null;
  deliveredAt: number | null;
  /** The event that fired the watch, as its owner serialised it. */
  eventJson: string | null;
}

export type NewAssistantWatch = Omit<AssistantWatch, "status" | "lastEvent" | "firedAt" | "deliveredAt" | "eventJson">;

export type AssistantWatchPatch = Partial<
  Pick<AssistantWatch, "status" | "armedRunning" | "lastEvent" | "firedAt" | "deliveredAt" | "eventJson" | "expiresAt">
>;

const MAX_ID_CHARS = 256;

function requireId(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_ID_CHARS) {
    throw new Error(`${what} must be a non-empty string of at most ${MAX_ID_CHARS} characters`);
  }
  return value;
}

function requireTime(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${what} must be a time in epoch milliseconds`);
  return Math.floor(value);
}

function requireStatus(value: unknown): WatchStatus {
  if (!WATCH_STATUSES.includes(value as WatchStatus)) throw new Error(`Unknown watch status "${String(value)}"`);
  return value as WatchStatus;
}

// ── Bindings ────────────────────────────────────────────────────────────────

interface BindingRow {
  telegram_chat_id: string;
  session_id: string;
  provider_id: string;
  updated_at: number;
}

const toBinding = (row: BindingRow): TelegramBinding => ({
  telegramChatId: row.telegram_chat_id,
  sessionId: resolveMigratedSession(row.session_id),
  providerId: row.provider_id,
  updatedAt: row.updated_at,
});

export function getTelegramBinding(telegramChatId: string): TelegramBinding | null {
  const row = getDb().query("SELECT * FROM assistant_telegram_bindings WHERE telegram_chat_id = ?")
    .get(requireId(telegramChatId, "telegramChatId")) as BindingRow | null;
  return row ? toBinding(row) : null;
}

/** Binds a Telegram chat to an Assistant session, replacing the session it was bound to. */
export function setTelegramBinding(telegramChatId: string, sessionId: string, providerId: string, now = Date.now()): void {
  getDb().query(`
    INSERT INTO assistant_telegram_bindings (telegram_chat_id, session_id, provider_id, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(telegram_chat_id) DO UPDATE SET
      session_id = excluded.session_id, provider_id = excluded.provider_id, updated_at = excluded.updated_at
  `).run(
    requireId(telegramChatId, "telegramChatId"), requireId(sessionId, "sessionId"),
    requireId(providerId, "providerId"), requireTime(now, "updatedAt"),
  );
}

/** False when the chat was not bound. */
export function deleteTelegramBinding(telegramChatId: string): boolean {
  const result = getDb().query("DELETE FROM assistant_telegram_bindings WHERE telegram_chat_id = ?")
    .run(requireId(telegramChatId, "telegramChatId"));
  return result.changes > 0;
}

export function listTelegramBindings(): TelegramBinding[] {
  const rows = getDb().query("SELECT * FROM assistant_telegram_bindings ORDER BY updated_at DESC").all() as BindingRow[];
  return rows.map(toBinding);
}

/** The Telegram chats bound to a session, whichever of its ids each binding was made under. */
export function telegramChatsBoundTo(sessionId: string): string[] {
  const current = resolveMigratedSession(requireId(sessionId, "sessionId"));
  return listTelegramBindings().filter((b) => b.sessionId === current).map((b) => b.telegramChatId);
}

// ── Watches ─────────────────────────────────────────────────────────────────

interface WatchRow {
  id: string;
  assistant_session_id: string;
  target_session_id: string;
  target_project: string;
  target_provider: string;
  created_at: number;
  expires_at: number;
  armed_running: number;
  status: string;
  last_event: string | null;
  fired_at: number | null;
  delivered_at: number | null;
  event_json: string | null;
}

const toWatch = (row: WatchRow): AssistantWatch => ({
  id: row.id,
  assistantSessionId: resolveMigratedSession(row.assistant_session_id),
  targetSessionId: resolveMigratedSession(row.target_session_id),
  targetProject: row.target_project,
  targetProvider: row.target_provider,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  armedRunning: row.armed_running === 1,
  status: row.status as WatchStatus,
  lastEvent: row.last_event,
  firedAt: row.fired_at,
  deliveredAt: row.delivered_at,
  eventJson: row.event_json,
});

export function insertAssistantWatch(watch: NewAssistantWatch): AssistantWatch {
  getDb().query(`
    INSERT INTO assistant_watches
      (id, assistant_session_id, target_session_id, target_project, target_provider, created_at, expires_at, armed_running, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(
    requireId(watch.id, "id"),
    requireId(watch.assistantSessionId, "assistantSessionId"),
    requireId(watch.targetSessionId, "targetSessionId"),
    requireId(watch.targetProject, "targetProject"),
    requireId(watch.targetProvider, "targetProvider"),
    requireTime(watch.createdAt, "createdAt"),
    requireTime(watch.expiresAt, "expiresAt"),
    watch.armedRunning ? 1 : 0,
  );
  return getAssistantWatch(watch.id)!;
}

export function getAssistantWatch(id: string): AssistantWatch | null {
  const row = getDb().query("SELECT * FROM assistant_watches WHERE id = ?").get(requireId(id, "id")) as WatchRow | null;
  return row ? toWatch(row) : null;
}

/** Watches matching every given filter, oldest first. Session filters compare current ids. */
export function listAssistantWatches(filter: {
  status?: WatchStatus;
  assistantSessionId?: string;
  targetSessionId?: string;
} = {}): AssistantWatch[] {
  const rows = (filter.status
    ? getDb().query("SELECT * FROM assistant_watches WHERE status = ? ORDER BY created_at, id").all(requireStatus(filter.status))
    : getDb().query("SELECT * FROM assistant_watches ORDER BY created_at, id").all()) as WatchRow[];
  const assistant = filter.assistantSessionId != null ? resolveMigratedSession(requireId(filter.assistantSessionId, "assistantSessionId")) : null;
  const target = filter.targetSessionId != null ? resolveMigratedSession(requireId(filter.targetSessionId, "targetSessionId")) : null;
  return rows.map(toWatch).filter((w) =>
    (assistant === null || w.assistantSessionId === assistant) && (target === null || w.targetSessionId === target));
}

/**
 * Deletes every watch a session set or is the target of, under any of its ids; the number
 * removed. For a deleted session, which can neither report nor be reported on any more.
 */
export function deleteAssistantWatchesFor(sessionId: string): number {
  const current = resolveMigratedSession(requireId(sessionId, "sessionId"));
  const ids = listAssistantWatches()
    .filter((w) => w.assistantSessionId === current || w.targetSessionId === current)
    .map((w) => w.id);
  const remove = getDb().query("DELETE FROM assistant_watches WHERE id = ?");
  for (const id of ids) remove.run(id);
  return ids.length;
}

const PATCH_COLUMNS: Record<keyof AssistantWatchPatch, string> = {
  status: "status",
  armedRunning: "armed_running",
  lastEvent: "last_event",
  firedAt: "fired_at",
  deliveredAt: "delivered_at",
  eventJson: "event_json",
  expiresAt: "expires_at",
};

function patchValue(key: keyof AssistantWatchPatch, value: unknown): string | number | null {
  switch (key) {
    case "status": return requireStatus(value);
    case "armedRunning": return value ? 1 : 0;
    case "expiresAt": return requireTime(value, key);
    case "firedAt":
    case "deliveredAt": return value === null ? null : requireTime(value, key);
    case "lastEvent":
    case "eventJson":
      if (value !== null && typeof value !== "string") throw new Error(`${key} must be a string or null`);
      return value;
  }
}

/**
 * Applies `patch`; false when no watch with that id exists or, with `ifStatus`, when it is no
 * longer in that status — which is how two events racing to fire one watch fire it once.
 */
export function updateAssistantWatch(id: string, patch: AssistantWatchPatch, opts: { ifStatus?: WatchStatus } = {}): boolean {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  for (const key of Object.keys(patch) as Array<keyof AssistantWatchPatch>) {
    if (!(key in PATCH_COLUMNS)) throw new Error(`Unknown watch field "${key}"`);
    if (patch[key] === undefined) continue;
    sets.push(`${PATCH_COLUMNS[key]} = ?`);
    values.push(patchValue(key, patch[key]));
  }
  if (sets.length === 0) return getAssistantWatch(id) !== null;
  let sql = `UPDATE assistant_watches SET ${sets.join(", ")} WHERE id = ?`;
  values.push(requireId(id, "id"));
  if (opts.ifStatus) {
    sql += " AND status = ?";
    values.push(requireStatus(opts.ifStatus));
  }
  return getDb().query(sql).run(...values).changes > 0;
}
