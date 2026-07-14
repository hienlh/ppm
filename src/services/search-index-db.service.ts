/**
 * Dedicated SQLite FTS5 store for full-text search over chat message content.
 *
 * Isolated in its own DB file (`~/.ppm/search-index.db`) so the potentially
 * large content index never bloats the primary `ppm.db`. Mirrors the
 * singleton + PRAGMA-user_version migration pattern of `db.service.ts`.
 */
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { getPpmDir } from "./ppm-dir.ts";

export const SEARCH_INDEX_SCHEMA_VERSION = 1;

let db: Database | null = null;

function getSearchIndexPath(): string {
  return resolve(getPpmDir(), "search-index.db");
}

/** Get or create the singleton search-index DB (lazy init). */
export function getSearchIndexDb(): Database {
  if (db) return db;
  const ppmDir = getPpmDir();
  if (!existsSync(ppmDir)) mkdirSync(ppmDir, { recursive: true });
  db = new Database(getSearchIndexPath());
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db);
  return db;
}

/** Close the DB (graceful shutdown / tests). */
export function closeSearchIndexDb(): void {
  if (db) { db.close(); db = null; }
}

/** Override the singleton with a custom DB instance (for tests). */
export function setSearchIndexDb(instance: Database): void {
  if (db) db.close();
  db = instance;
}

/** For tests: isolated in-memory DB with schema applied. */
export function openTestSearchIndexDb(): Database {
  const testDb = new Database(":memory:");
  runMigrations(testDb);
  return testDb;
}

function runMigrations(database: Database): void {
  const row = database.query("PRAGMA user_version").get() as { user_version: number };
  if (row.user_version < 1) {
    // FTS5 virtual table: only `text` is indexed; the rest are UNINDEXED
    // sidecar columns retrievable per match. unicode61 tokenizer keeps
    // diacritics reasonable; remove_diacritics folds accented chars so a
    // query without tones still matches (helps Vietnamese search).
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        text,
        session_id UNINDEXED,
        project_path UNINDEXED,
        message_id UNINDEXED,
        role UNINDEXED,
        ts UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE TABLE IF NOT EXISTS session_meta (
        session_id  TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        jsonl_mtime INTEGER NOT NULL DEFAULT 0,
        indexed_at  INTEGER NOT NULL DEFAULT 0,
        msg_count   INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_session_meta_project ON session_meta(project_path);
    `);
    database.exec(`PRAGMA user_version = ${SEARCH_INDEX_SCHEMA_VERSION}`);
  }
}
