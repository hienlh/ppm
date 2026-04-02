import { Database, type SQLQueryBindings } from "bun:sqlite";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";

const PPM_DIR = process.env.PPM_HOME || resolve(homedir(), ".ppm");
const CURRENT_SCHEMA_VERSION = 12;

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

  if (current < 2) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK(type IN ('sqlite', 'postgres')),
        name TEXT NOT NULL UNIQUE,
        connection_config TEXT NOT NULL,
        group_name TEXT,
        color TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_connections_type ON connections(type);
      CREATE INDEX IF NOT EXISTS idx_connections_group ON connections(group_name);

      PRAGMA user_version = 2;
    `);
  }

  if (current < 3) {
    // Add readonly column (safe-by-default: 1 = block writes, UI-only toggle)
    try {
      database.exec(`ALTER TABLE connections ADD COLUMN readonly INTEGER NOT NULL DEFAULT 1`);
    } catch {
      // Column may already exist (fresh DB created in this session)
    }

    database.exec(`
      CREATE TABLE IF NOT EXISTS connection_table_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        table_name TEXT NOT NULL,
        schema_name TEXT NOT NULL DEFAULT 'public',
        row_count INTEGER NOT NULL DEFAULT 0,
        cached_at TEXT DEFAULT (datetime('now')),
        UNIQUE(connection_id, schema_name, table_name)
      );

      CREATE INDEX IF NOT EXISTS idx_table_cache_conn ON connection_table_cache(connection_id);

      PRAGMA user_version = 3;
    `);
  }

  if (current < 4) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS claude_limit_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        five_hour_util REAL,
        five_hour_resets_at TEXT,
        weekly_util REAL,
        weekly_resets_at TEXT,
        weekly_opus_util REAL,
        weekly_opus_resets_at TEXT,
        weekly_sonnet_util REAL,
        weekly_sonnet_resets_at TEXT,
        recorded_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_limit_snapshots_recorded ON claude_limit_snapshots(recorded_at);

      PRAGMA user_version = 4;
    `);
  }

  if (current < 5) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        label TEXT,
        email TEXT,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        cooldown_until INTEGER,
        priority INTEGER NOT NULL DEFAULT 0,
        total_requests INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);

      PRAGMA user_version = 5;
    `);
  }

  if (current < 6) {
    database.exec(`
      ALTER TABLE claude_limit_snapshots ADD COLUMN account_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_limit_snapshots_account ON claude_limit_snapshots(account_id);
      PRAGMA user_version = 6;
    `);
  }

  if (current < 7) {
    try {
      database.exec(`ALTER TABLE accounts ADD COLUMN profile_json TEXT`);
    } catch {
      // Column may already exist
    }
    database.exec(`PRAGMA user_version = 7`);
  }

  if (current < 8) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        name TEXT PRIMARY KEY,
        transport TEXT NOT NULL DEFAULT 'stdio',
        config TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS session_titles (
        session_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      PRAGMA user_version = 8;
    `);
  }

  if (current < 9) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS session_pins (
        session_id TEXT PRIMARY KEY,
        pinned_at TEXT DEFAULT (datetime('now'))
      );

      PRAGMA user_version = 9;
    `);
  }

  if (current < 10) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS workspace_state (
        project_name TEXT PRIMARY KEY,
        layout_json  TEXT NOT NULL,
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );

      PRAGMA user_version = 10;
    `);
  }

  if (current < 11) {
    try {
      database.exec(`ALTER TABLE session_map ADD COLUMN project_path TEXT`);
    } catch {
      // Column may already exist
    }
    // Backfill project_path from projects table where project_name matches
    database.exec(`
      UPDATE session_map SET project_path = (
        SELECT path FROM projects WHERE projects.name = session_map.project_name
      ) WHERE project_path IS NULL AND project_name IS NOT NULL
    `);
    database.exec(`PRAGMA user_version = 11`);
  }

  if (current < 12) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS extensions (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        display_name TEXT,
        description TEXT,
        icon TEXT,
        enabled INTEGER DEFAULT 1,
        manifest TEXT NOT NULL,
        installed_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS extension_storage (
        ext_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        PRIMARY KEY (ext_id, scope, key),
        FOREIGN KEY (ext_id) REFERENCES extensions(id) ON DELETE CASCADE
      );

      PRAGMA user_version = 12;
    `);
  }
}

// ---------------------------------------------------------------------------
// Workspace helpers
// ---------------------------------------------------------------------------

export interface WorkspaceRow {
  project_name: string;
  layout_json: string;
  updated_at: string;
}

export function getWorkspace(projectName: string): WorkspaceRow | null {
  return getDb().query(
    "SELECT project_name, layout_json, updated_at FROM workspace_state WHERE project_name = ?",
  ).get(projectName) as WorkspaceRow | null;
}

export function setWorkspace(projectName: string, layoutJson: string): string {
  const now = new Date().toISOString();
  getDb().query(
    "INSERT INTO workspace_state (project_name, layout_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(project_name) DO UPDATE SET layout_json = excluded.layout_json, updated_at = excluded.updated_at",
  ).run(projectName, layoutJson, now);
  return now;
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

export function getSessionProjectPath(ppmId: string): string | null {
  const row = getDb().query("SELECT project_path FROM session_map WHERE ppm_id = ?").get(ppmId) as { project_path: string } | null;
  return row?.project_path ?? null;
}

export function setSessionMapping(ppmId: string, sdkId: string, projectName?: string, projectPath?: string): void {
  getDb().query(
    "INSERT INTO session_map (ppm_id, sdk_id, project_name, project_path) VALUES (?, ?, ?, ?) ON CONFLICT(ppm_id) DO UPDATE SET sdk_id = excluded.sdk_id, project_name = COALESCE(excluded.project_name, session_map.project_name), project_path = COALESCE(excluded.project_path, session_map.project_path)",
  ).run(ppmId, sdkId, projectName ?? null, projectPath ?? null);
}

export function getAllSessionMappings(): Record<string, string> {
  const rows = getDb().query("SELECT ppm_id, sdk_id FROM session_map").all() as { ppm_id: string; sdk_id: string }[];
  const result: Record<string, string> = {};
  for (const r of rows) result[r.ppm_id] = r.sdk_id;
  return result;
}

// ---------------------------------------------------------------------------
// Session title helpers (user-set titles persisted in PPM DB)
// ---------------------------------------------------------------------------

export function getSessionTitle(sessionId: string): string | null {
  const row = getDb().query("SELECT title FROM session_titles WHERE session_id = ?").get(sessionId) as { title: string } | null;
  return row?.title ?? null;
}

export function setSessionTitle(sessionId: string, title: string): void {
  getDb().query(
    "INSERT INTO session_titles (session_id, title, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(session_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at",
  ).run(sessionId, title);
}

/** Bulk-fetch DB titles for a list of session IDs. Returns map of id → title. */
export function getSessionTitles(sessionIds: string[]): Record<string, string> {
  if (sessionIds.length === 0) return {};
  const placeholders = sessionIds.map(() => "?").join(", ");
  const rows = getDb().query(
    `SELECT session_id, title FROM session_titles WHERE session_id IN (${placeholders})`,
  ).all(...sessionIds) as { session_id: string; title: string }[];
  const result: Record<string, string> = {};
  for (const r of rows) result[r.session_id] = r.title;
  return result;
}

// ---------------------------------------------------------------------------
// Session pin helpers
// ---------------------------------------------------------------------------

export function pinSession(sessionId: string): void {
  getDb().query(
    "INSERT INTO session_pins (session_id, pinned_at) VALUES (?, datetime('now')) ON CONFLICT(session_id) DO UPDATE SET pinned_at = datetime('now')",
  ).run(sessionId);
}

export function unpinSession(sessionId: string): void {
  getDb().query("DELETE FROM session_pins WHERE session_id = ?").run(sessionId);
}

export function getPinnedSessionIds(): Set<string> {
  const rows = getDb().query("SELECT session_id FROM session_pins ORDER BY pinned_at DESC").all() as { session_id: string }[];
  return new Set(rows.map((r) => r.session_id));
}

export function deleteSessionMapping(ppmId: string): void {
  getDb().query("DELETE FROM session_map WHERE ppm_id = ?").run(ppmId);
}

export function deleteSessionTitle(sessionId: string): void {
  getDb().query("DELETE FROM session_titles WHERE session_id = ?").run(sessionId);
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

// ---------------------------------------------------------------------------
// Claude limit snapshot helpers
// ---------------------------------------------------------------------------

export interface LimitSnapshotRow {
  id: number;
  account_id: string | null;
  five_hour_util: number | null;
  five_hour_resets_at: string | null;
  weekly_util: number | null;
  weekly_resets_at: string | null;
  weekly_opus_util: number | null;
  weekly_opus_resets_at: string | null;
  weekly_sonnet_util: number | null;
  weekly_sonnet_resets_at: string | null;
  recorded_at: string;
}

export function insertLimitSnapshot(data: Omit<LimitSnapshotRow, "id" | "recorded_at">): void {
  getDb().query(
    `INSERT INTO claude_limit_snapshots
      (account_id, five_hour_util, five_hour_resets_at, weekly_util, weekly_resets_at,
       weekly_opus_util, weekly_opus_resets_at, weekly_sonnet_util, weekly_sonnet_resets_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    data.account_id ?? null,
    data.five_hour_util ?? null, data.five_hour_resets_at ?? null,
    data.weekly_util ?? null, data.weekly_resets_at ?? null,
    data.weekly_opus_util ?? null, data.weekly_opus_resets_at ?? null,
    data.weekly_sonnet_util ?? null, data.weekly_sonnet_resets_at ?? null,
  );
}

export function getLatestLimitSnapshot(): LimitSnapshotRow | null {
  return getDb().query(
    "SELECT * FROM claude_limit_snapshots ORDER BY recorded_at DESC, id DESC LIMIT 1",
  ).get() as LimitSnapshotRow | null;
}

export function getLatestSnapshotForAccount(accountId: string): LimitSnapshotRow | null {
  return getDb().query(
    "SELECT * FROM claude_limit_snapshots WHERE account_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1",
  ).get(accountId) as LimitSnapshotRow | null;
}

export function getAllLatestSnapshots(): LimitSnapshotRow[] {
  return getDb().query(
    `SELECT s.* FROM claude_limit_snapshots s
     INNER JOIN (
       SELECT account_id, MAX(id) as max_id
       FROM claude_limit_snapshots WHERE account_id IS NOT NULL
       GROUP BY account_id
     ) latest ON s.id = latest.max_id`,
  ).all() as LimitSnapshotRow[];
}

export function touchSnapshotTimestamp(accountId: string): void {
  getDb().query(
    `UPDATE claude_limit_snapshots SET recorded_at = datetime('now')
     WHERE id = (SELECT id FROM claude_limit_snapshots WHERE account_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1)`,
  ).run(accountId);
}

export function deleteSnapshotsForAccount(accountId: string): void {
  getDb().query("DELETE FROM claude_limit_snapshots WHERE account_id = ?").run(accountId);
}

export function cleanupOldLimitSnapshots(): void {
  getDb().query(
    "DELETE FROM claude_limit_snapshots WHERE recorded_at < datetime('now', '-7 days')",
  ).run();
}

// ---------------------------------------------------------------------------
// Connection helpers
// ---------------------------------------------------------------------------

export interface ConnectionRow {
  id: number;
  type: "sqlite" | "postgres";
  name: string;
  connection_config: string;
  group_name: string | null;
  color: string | null;
  /** 1 = readonly (default), 0 = writable. UI-only toggle — CLI cannot change this. */
  readonly: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** Parsed config stored in connection_config JSON */
export type ConnectionConfig =
  | { type: "sqlite"; path: string }
  | { type: "postgres"; connectionString: string };

export function getConnections(): ConnectionRow[] {
  return getDb().query(
    "SELECT * FROM connections ORDER BY sort_order, id",
  ).all() as ConnectionRow[];
}

export function getConnectionById(id: number): ConnectionRow | null {
  return getDb().query("SELECT * FROM connections WHERE id = ?").get(id) as ConnectionRow | null;
}

export function getConnectionByName(name: string): ConnectionRow | null {
  return getDb().query("SELECT * FROM connections WHERE name = ?").get(name) as ConnectionRow | null;
}

/** Resolve a connection by name or numeric ID */
export function resolveConnection(nameOrId: string): ConnectionRow | null {
  const asNum = Number(nameOrId);
  if (!Number.isNaN(asNum) && Number.isInteger(asNum)) {
    return getConnectionById(asNum) ?? getConnectionByName(nameOrId);
  }
  return getConnectionByName(nameOrId);
}

export function insertConnection(
  type: "sqlite" | "postgres", name: string, config: ConnectionConfig,
  groupName?: string | null, color?: string | null,
): ConnectionRow {
  const maxOrder = (getDb().query("SELECT COALESCE(MAX(sort_order), -1) as m FROM connections").get() as { m: number }).m;
  getDb().query(
    "INSERT INTO connections (type, name, connection_config, group_name, color, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(type, name, JSON.stringify(config), groupName ?? null, color ?? null, maxOrder + 1);
  return getConnectionByName(name)!;
}

export function deleteConnection(nameOrId: string): boolean {
  const conn = resolveConnection(nameOrId);
  if (!conn) return false;
  getDb().query("DELETE FROM connections WHERE id = ?").run(conn.id);
  return true;
}

export function updateConnection(
  id: number, updates: { name?: string; config?: ConnectionConfig; groupName?: string | null; color?: string | null; readonly?: number },
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (updates.name !== undefined) { sets.push("name = ?"); vals.push(updates.name); }
  if (updates.config !== undefined) { sets.push("connection_config = ?"); vals.push(JSON.stringify(updates.config)); }
  if (updates.groupName !== undefined) { sets.push("group_name = ?"); vals.push(updates.groupName); }
  if (updates.color !== undefined) { sets.push("color = ?"); vals.push(updates.color); }
  if (updates.readonly !== undefined) { sets.push("readonly = ?"); vals.push(updates.readonly); }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  getDb().query(`UPDATE connections SET ${sets.join(", ")} WHERE id = ?`).run(...(vals as SQLQueryBindings[]));
}

// ---------------------------------------------------------------------------
// Table cache helpers
// ---------------------------------------------------------------------------

export interface TableCacheRow {
  id: number;
  connection_id: number;
  table_name: string;
  schema_name: string;
  row_count: number;
  cached_at: string;
}

export function getCachedTables(connectionId: number): TableCacheRow[] {
  return getDb().query(
    "SELECT * FROM connection_table_cache WHERE connection_id = ? ORDER BY schema_name, table_name",
  ).all(connectionId) as TableCacheRow[];
}

export function upsertTableCache(connectionId: number, tableName: string, schemaName: string, rowCount: number): void {
  getDb().query(
    `INSERT INTO connection_table_cache (connection_id, table_name, schema_name, row_count, cached_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(connection_id, schema_name, table_name)
     DO UPDATE SET row_count = excluded.row_count, cached_at = excluded.cached_at`,
  ).run(connectionId, tableName, schemaName, rowCount);
}

export function deleteTableCache(connectionId: number): void {
  getDb().query("DELETE FROM connection_table_cache WHERE connection_id = ?").run(connectionId);
}

export function searchTableCache(query: string): Array<TableCacheRow & { connection_name: string; connection_type: string; connection_color: string | null }> {
  // Escape LIKE wildcards so user input is treated as literal text
  const escaped = query.replace(/[%_\\]/g, "\\$&");
  return getDb().query(
    `SELECT tc.*, c.name as connection_name, c.type as connection_type, c.color as connection_color
     FROM connection_table_cache tc
     JOIN connections c ON tc.connection_id = c.id
     WHERE tc.table_name LIKE ? ESCAPE '\\'
     ORDER BY tc.table_name, c.name
     LIMIT 50`,
  ).all(`%${escaped}%`) as Array<TableCacheRow & { connection_name: string; connection_type: string; connection_color: string | null }>;
}

// ---------------------------------------------------------------------------
// Account helpers
// ---------------------------------------------------------------------------

export interface AccountRow {
  id: string;
  label: string | null;
  email: string | null;
  access_token: string;
  refresh_token: string;
  expires_at: number | null;
  status: "active" | "cooldown" | "disabled";
  cooldown_until: number | null;
  priority: number;
  total_requests: number;
  last_used_at: number | null;
  profile_json: string | null;
  created_at: number;
}

export function getAccounts(): AccountRow[] {
  return getDb().query("SELECT * FROM accounts ORDER BY priority DESC, created_at ASC").all() as AccountRow[];
}

export function getAccountById(id: string): AccountRow | null {
  return getDb().query("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | null;
}

export function insertAccount(row: Omit<AccountRow, "created_at">): void {
  getDb().query(
    `INSERT INTO accounts (id, label, email, access_token, refresh_token, expires_at, status, cooldown_until, priority, total_requests, last_used_at, profile_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.label, row.email, row.access_token, row.refresh_token,
    row.expires_at, row.status, row.cooldown_until, row.priority,
    row.total_requests, row.last_used_at, row.profile_json,
  );
}

export function updateAccount(id: string, updates: Partial<Omit<AccountRow, "id" | "created_at">>): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (updates.label !== undefined) { sets.push("label = ?"); vals.push(updates.label); }
  if (updates.email !== undefined) { sets.push("email = ?"); vals.push(updates.email); }
  if (updates.access_token !== undefined) { sets.push("access_token = ?"); vals.push(updates.access_token); }
  if (updates.refresh_token !== undefined) { sets.push("refresh_token = ?"); vals.push(updates.refresh_token); }
  if (updates.expires_at !== undefined) { sets.push("expires_at = ?"); vals.push(updates.expires_at); }
  if (updates.status !== undefined) { sets.push("status = ?"); vals.push(updates.status); }
  if (updates.cooldown_until !== undefined) { sets.push("cooldown_until = ?"); vals.push(updates.cooldown_until); }
  if (updates.priority !== undefined) { sets.push("priority = ?"); vals.push(updates.priority); }
  if (updates.total_requests !== undefined) { sets.push("total_requests = ?"); vals.push(updates.total_requests); }
  if (updates.last_used_at !== undefined) { sets.push("last_used_at = ?"); vals.push(updates.last_used_at); }
  if (updates.profile_json !== undefined) { sets.push("profile_json = ?"); vals.push(updates.profile_json); }
  if (sets.length === 0) return;
  vals.push(id);
  getDb().query(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`).run(...(vals as SQLQueryBindings[]));
}

export function deleteAccount(id: string): void {
  getDb().query("DELETE FROM accounts WHERE id = ?").run(id);
}

export function incrementAccountRequests(id: string): void {
  getDb().query("UPDATE accounts SET total_requests = total_requests + 1 WHERE id = ?").run(id);
}

// ---------------------------------------------------------------------------
// Extension helpers
// ---------------------------------------------------------------------------

import type { ExtensionRow, ExtensionStorageRow } from "../types/extension.ts";

export function getExtensions(): ExtensionRow[] {
  return getDb().query("SELECT * FROM extensions ORDER BY display_name, id").all() as ExtensionRow[];
}

export function getExtensionById(id: string): ExtensionRow | null {
  return getDb().query("SELECT * FROM extensions WHERE id = ?").get(id) as ExtensionRow | null;
}

export function insertExtension(row: Omit<ExtensionRow, "installed_at" | "updated_at">): void {
  getDb().query(
    `INSERT INTO extensions (id, version, display_name, description, icon, enabled, manifest)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.version, row.display_name, row.description, row.icon, row.enabled, row.manifest);
}

export function updateExtension(id: string, updates: Partial<Pick<ExtensionRow, "version" | "display_name" | "description" | "icon" | "enabled" | "manifest">>): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (updates.version !== undefined) { sets.push("version = ?"); vals.push(updates.version); }
  if (updates.display_name !== undefined) { sets.push("display_name = ?"); vals.push(updates.display_name); }
  if (updates.description !== undefined) { sets.push("description = ?"); vals.push(updates.description); }
  if (updates.icon !== undefined) { sets.push("icon = ?"); vals.push(updates.icon); }
  if (updates.enabled !== undefined) { sets.push("enabled = ?"); vals.push(updates.enabled); }
  if (updates.manifest !== undefined) { sets.push("manifest = ?"); vals.push(updates.manifest); }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  getDb().query(`UPDATE extensions SET ${sets.join(", ")} WHERE id = ?`).run(...(vals as SQLQueryBindings[]));
}

export function deleteExtension(id: string): void {
  getDb().query("DELETE FROM extensions WHERE id = ?").run(id);
}

export function getExtensionStorage(extId: string, scope: string): ExtensionStorageRow[] {
  return getDb().query("SELECT * FROM extension_storage WHERE ext_id = ? AND scope = ?").all(extId, scope) as ExtensionStorageRow[];
}

export function setExtensionStorageValue(extId: string, scope: string, key: string, value: string | null): void {
  getDb().query(
    `INSERT INTO extension_storage (ext_id, scope, key, value)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(ext_id, scope, key) DO UPDATE SET value = excluded.value`,
  ).run(extId, scope, key, value);
}

export function deleteExtensionStorage(extId: string): void {
  getDb().query("DELETE FROM extension_storage WHERE ext_id = ?").run(extId);
}

// Auto-close on process exit
process.on("beforeExit", closeDb);
