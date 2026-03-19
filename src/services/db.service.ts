import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";

const PPM_DIR = resolve(homedir(), ".ppm");
const CURRENT_SCHEMA_VERSION = 1;

let db: Database | null = null;
let dbProfile: string | null = null;

/** Set DB profile before first access. "dev" → ppm.dev.db, null → ppm.db */
export function setDbProfile(profile: string | null): void {
  if (db) throw new Error("Cannot change DB profile after DB is open");
  dbProfile = profile;
}

function getDbPath(): string {
  if (dbProfile) return resolve(PPM_DIR, `ppm.${dbProfile}.db`);
  return resolve(PPM_DIR, "ppm.db");
}

/** Get or create the singleton DB instance (lazy init) */
export function getDb(): Database {
  if (db) return db;
  if (!existsSync(PPM_DIR)) mkdirSync(PPM_DIR, { recursive: true });
  db = new Database(getDbPath());
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  return db;
}

/** Close the DB (for graceful shutdown or tests) */
export function closeDb(): void {
  if (db) { db.close(); db = null; }
}

/** For tests: open an isolated in-memory DB with schema applied */
export function openTestDb(): Database {
  const testDb = new Database(":memory:");
  testDb.exec("PRAGMA journal_mode = WAL");
  testDb.exec("PRAGMA foreign_keys = ON");
  runMigrations(testDb);
  return testDb;
}

/** Override the singleton with a custom DB instance (for tests) */
export function setDb(instance: Database): void {
  if (db) db.close();
  db = instance;
}

// ---------------------------------------------------------------------------
// Schema migrations
// ---------------------------------------------------------------------------

function runMigrations(database: Database): void {
  const row = database.query("PRAGMA user_version").get() as { user_version: number };
  const current = row.user_version;

  if (current < 1) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL UNIQUE,
        color TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS session_map (
        ppm_id TEXT PRIMARY KEY,
        sdk_id TEXT NOT NULL,
        project_name TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        expiration_time TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS session_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS usage_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cost_usd REAL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        model TEXT,
        session_id TEXT,
        project_name TEXT,
        five_hour_pct REAL,
        weekly_pct REAL,
        recorded_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_session_logs_session ON session_logs(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_logs_created ON session_logs(created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_history(session_id);
      CREATE INDEX IF NOT EXISTS idx_usage_recorded ON usage_history(recorded_at);
      CREATE INDEX IF NOT EXISTS idx_projects_sort ON projects(sort_order);

      PRAGMA user_version = 1;
    `);
  }
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

export function getConfigValue(key: string): string | null {
  const row = getDb().query("SELECT value FROM config WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function setConfigValue(key: string, value: string): void {
  getDb().query(
    "INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, value);
}

export function getAllConfig(): Record<string, string> {
  const rows = getDb().query("SELECT key, value FROM config").all() as { key: string; value: string }[];
  const result: Record<string, string> = {};
  for (const r of rows) result[r.key] = r.value;
  return result;
}

export function deleteConfigValue(key: string): void {
  getDb().query("DELETE FROM config WHERE key = ?").run(key);
}

// ---------------------------------------------------------------------------
// Project helpers
// ---------------------------------------------------------------------------

export interface ProjectRow {
  id: number;
  path: string;
  name: string;
  color: string | null;
  sort_order: number;
}

export function getProjects(): ProjectRow[] {
  return getDb().query("SELECT id, path, name, color, sort_order FROM projects ORDER BY sort_order, id").all() as ProjectRow[];
}

export function upsertProject(path: string, name: string, color?: string | null): void {
  const maxOrder = (getDb().query("SELECT COALESCE(MAX(sort_order), -1) as m FROM projects").get() as { m: number }).m;
  getDb().query(
    "INSERT INTO projects (path, name, color, sort_order) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET name = excluded.name, color = excluded.color",
  ).run(path, name, color ?? null, maxOrder + 1);
}

export function deleteProject(nameOrPath: string): void {
  getDb().query("DELETE FROM projects WHERE name = ? OR path = ?").run(nameOrPath, nameOrPath);
}

export function updateProject(currentName: string, newName: string, newPath: string, color?: string | null): void {
  getDb().query(
    "UPDATE projects SET name = ?, path = ?, color = ? WHERE name = ?",
  ).run(newName, newPath, color ?? null, currentName);
}

// ---------------------------------------------------------------------------
// Session map helpers
// ---------------------------------------------------------------------------

export function getSessionMapping(ppmId: string): string | null {
  const row = getDb().query("SELECT sdk_id FROM session_map WHERE ppm_id = ?").get(ppmId) as { sdk_id: string } | null;
  return row?.sdk_id ?? null;
}

export function setSessionMapping(ppmId: string, sdkId: string, projectName?: string): void {
  getDb().query(
    "INSERT INTO session_map (ppm_id, sdk_id, project_name) VALUES (?, ?, ?) ON CONFLICT(ppm_id) DO UPDATE SET sdk_id = excluded.sdk_id, project_name = excluded.project_name",
  ).run(ppmId, sdkId, projectName ?? null);
}

export function getAllSessionMappings(): Record<string, string> {
  const rows = getDb().query("SELECT ppm_id, sdk_id FROM session_map").all() as { ppm_id: string; sdk_id: string }[];
  const result: Record<string, string> = {};
  for (const r of rows) result[r.ppm_id] = r.sdk_id;
  return result;
}

// ---------------------------------------------------------------------------
// Push subscription helpers
// ---------------------------------------------------------------------------

export interface PushSubRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  expiration_time: string | null;
}

export function getPushSubscriptions(): PushSubRow[] {
  return getDb().query("SELECT endpoint, p256dh, auth, expiration_time FROM push_subscriptions").all() as PushSubRow[];
}

export function upsertPushSubscription(endpoint: string, p256dh: string, auth: string, expirationTime?: string | null): void {
  getDb().query(
    "INSERT INTO push_subscriptions (endpoint, p256dh, auth, expiration_time) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, expiration_time = excluded.expiration_time",
  ).run(endpoint, p256dh, auth, expirationTime ?? null);
}

export function deletePushSubscription(endpoint: string): void {
  getDb().query("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
}

// ---------------------------------------------------------------------------
// Session log helpers
// ---------------------------------------------------------------------------

export interface SessionLogRow {
  id: number;
  session_id: string;
  level: string;
  message: string;
  created_at: string;
}

export function insertSessionLog(sessionId: string, level: string, message: string): void {
  getDb().query(
    "INSERT INTO session_logs (session_id, level, message) VALUES (?, ?, ?)",
  ).run(sessionId, level, message);
}

export function getSessionLogs(sessionId: string, limit = 100): SessionLogRow[] {
  return getDb().query(
    "SELECT id, session_id, level, message, created_at FROM session_logs WHERE session_id = ? ORDER BY id DESC LIMIT ?",
  ).all(sessionId, limit) as SessionLogRow[];
}

// ---------------------------------------------------------------------------
// Usage history helpers
// ---------------------------------------------------------------------------

export interface UsageRow {
  id: number;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  model: string | null;
  session_id: string | null;
  project_name: string | null;
  five_hour_pct: number | null;
  weekly_pct: number | null;
  recorded_at: string;
}

export function insertUsageRecord(record: {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  sessionId?: string;
  projectName?: string;
  fiveHourPct?: number;
  weeklyPct?: number;
}): void {
  getDb().query(
    "INSERT INTO usage_history (cost_usd, input_tokens, output_tokens, model, session_id, project_name, five_hour_pct, weekly_pct) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    record.costUsd ?? null, record.inputTokens ?? null, record.outputTokens ?? null,
    record.model ?? null, record.sessionId ?? null, record.projectName ?? null,
    record.fiveHourPct ?? null, record.weeklyPct ?? null,
  );
}

export function getUsageSince(since: string): UsageRow[] {
  return getDb().query(
    "SELECT * FROM usage_history WHERE recorded_at >= ? ORDER BY recorded_at DESC",
  ).all(since) as UsageRow[];
}

export function getDbFilePath(): string {
  return getDbPath();
}

// Auto-close on process exit
process.on("beforeExit", closeDb);
