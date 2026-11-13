/**
 * The memory search index, `<memory>/index.db`. The Markdown files are the truth: every row
 * here is rebuilt from them by `reconcile` (vectors aside, which are recomputed), so a corrupt
 * file is moved aside and rebuilt rather than repaired.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger } from "../logger.ts";
import { parseMemoryFile } from "./memory-file.ts";
import { memoryIndexPath } from "./memory-paths.ts";
import type { MemoryScope, MemorySource, MemoryType } from "./memory-types.ts";

const log = createLogger("memory-index");

/** The `project_key` of the global folder's rows. Project keys are 16 hex, so it never collides. */
export const GLOBAL_MEMORY_KEY = "global";

/** Files read between two yields to the event loop during a reconcile. */
const YIELD_EVERY = 64;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL,
  scope TEXT NOT NULL,
  project_key TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  updated TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  mtime REAL NOT NULL,
  size INTEGER NOT NULL,
  revision TEXT NOT NULL,
  UNIQUE (project_key, id)
);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  name, description, body,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS vectors (
  id TEXT NOT NULL,
  scope TEXT NOT NULL,
  project_key TEXT NOT NULL,
  model TEXT NOT NULL,
  revision TEXT NOT NULL,
  dims INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (project_key, id, model)
);
`;

/** One indexed memory, without its body. */
export interface MemoryIndexRow {
  id: string;
  scope: MemoryScope;
  projectKey: string;
  path: string;
  name: string;
  description: string;
  type: MemoryType;
  source: MemorySource;
  updated: string;
  archived: boolean;
  revision: string;
}

/** A text search hit; `score` is its bm25 relative to the top hit (top = 1). */
export interface TextHit extends MemoryIndexRow {
  score: number;
}

export interface StoredVector {
  id: string;
  scope: MemoryScope;
  projectKey: string;
  model: string;
  revision: string;
  vector: Float32Array;
}

export interface ReconcileResult {
  /** Files read and (re)indexed because they were new or their mtime/size moved. */
  read: number;
  /** Rows dropped because their file is gone. */
  removed: number;
  /** Memory files in the folder. */
  total: number;
}

/**
 * Maps `đ/Đ` to `d/D`: `remove_diacritics` leaves `đ` alone (it is a letter, not a `d` with a
 * mark), so "đồng bộ" would never meet "dong bo" without it. Applied to indexed text and queries.
 */
export function fold(text: string): string {
  return text.replace(/[đĐ]/g, (c) => (c === "đ" ? "d" : "D"));
}

/** The query's words, folded, as FTS sees them. */
function queryTerms(query: string): string[] {
  return fold(query).split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean);
}

/** The query's words, each quoted (so FTS syntax in a query is text), OR-ed. Empty when it has none. */
function matchExpression(query: string): string {
  return queryTerms(query).map((t) => `"${t}"`).join(" OR ");
}

/** One memory's share of a query's words (`MemoryIndex.coverage`). */
export interface TermCoverage {
  projectKey: string;
  id: string;
  /** 0–1: the weight of the query's words it holds over the weight of all of them. */
  coverage: number;
}

const yieldToLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface DbRow {
  rid: number;
  id: string;
  scope: MemoryScope;
  project_key: string;
  path: string;
  name: string;
  description: string;
  type: MemoryType;
  source: MemorySource;
  updated: string;
  archived: number;
  mtime: number;
  size: number;
  revision: string;
}

const toRow = (r: DbRow): MemoryIndexRow => ({
  id: r.id,
  scope: r.scope,
  projectKey: r.project_key,
  path: r.path,
  name: r.name,
  description: r.description,
  type: r.type,
  source: r.source,
  updated: r.updated,
  archived: r.archived === 1,
  revision: r.revision,
});

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** Opens with `busy_timeout` first (see CLAUDE.md), then WAL; throws on a file SQLite cannot use. */
function connect(path: string): Database {
  const db = new Database(path, { create: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    const check = db.query("PRAGMA quick_check").get() as { quick_check?: string } | null;
    if (check?.quick_check !== "ok") throw new Error(`quick_check: ${check?.quick_check ?? "no answer"}`);
    db.exec(SCHEMA);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/** Renames the index (and its WAL/SHM) to `index.db.broken-<ts>`, returning the new name. */
function moveAside(path: string): string {
  const broken = `${path}.broken-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  if (existsSync(path)) renameSync(path, broken);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(path + suffix)) renameSync(path + suffix, broken + suffix);
  }
  return broken;
}

export class MemoryIndex {
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly path: string,
    private readonly db: Database,
    /** Where a corrupt or unopenable file was moved when this open replaced it. */
    readonly brokenPath?: string,
  ) {}

  /** Opens (creating) the index; a file that fails to open or `quick_check` is moved aside and a fresh one made. */
  static open(path: string = memoryIndexPath()): MemoryIndex {
    mkdirSync(dirname(path), { recursive: true });
    try {
      return new MemoryIndex(path, connect(path));
    } catch (err) {
      const brokenPath = moveAside(path);
      log.warn(`memory index ${path} unusable (${err instanceof Error ? err.message : String(err)}); moved to ${brokenPath}, rebuilding from the Markdown files`);
      return new MemoryIndex(path, connect(path), brokenPath);
    }
  }

  close(): void {
    this.db.close();
  }

  /** Runs reconciles one at a time, so two over the same folder never interleave. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Brings one folder's rows in line with its `*.md` files: reads only files that are new or
   * whose mtime/size moved, drops rows (and vectors) of files that are gone. A missing folder
   * is an empty one. Yields to the event loop every 64 files.
   */
  reconcile(dir: string, scope: MemoryScope, projectKey: string): Promise<ReconcileResult> {
    return this.serial(() => this.reconcileNow(dir, scope, projectKey));
  }

  private async reconcileNow(dir: string, scope: MemoryScope, projectKey: string): Promise<ReconcileResult> {
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith(".md") && !n.startsWith("."));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      names = [];
    }

    const known = new Map<string, { mtime: number; size: number }>();
    for (const r of this.db.query("SELECT id, mtime, size FROM memories WHERE project_key = ?").all(projectKey) as DbRow[]) {
      known.set(r.id, { mtime: r.mtime, size: r.size });
    }

    const upsert = this.db.query(`
      INSERT INTO memories (id, scope, project_key, path, name, description, type, source, updated, archived, mtime, size, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (project_key, id) DO UPDATE SET
        scope = excluded.scope, path = excluded.path, name = excluded.name, description = excluded.description,
        type = excluded.type, source = excluded.source, updated = excluded.updated, archived = excluded.archived,
        mtime = excluded.mtime, size = excluded.size, revision = excluded.revision
      RETURNING rid`);
    const dropFts = this.db.query("DELETE FROM memories_fts WHERE rowid = ?");
    const addFts = this.db.query("INSERT INTO memories_fts (rowid, name, description, body) VALUES (?, ?, ?, ?)");
    const write = this.db.transaction((args: { id: string; path: string; mtime: number; size: number; text: string }) => {
      const m = parseMemoryFile(args.text, args.id, scope);
      const { rid } = upsert.get(
        m.id, scope, projectKey, args.path, m.name, m.description, m.type, m.source, m.updated,
        m.archived ? 1 : 0, args.mtime, args.size, m.revision,
      ) as { rid: number };
      dropFts.run(rid);
      addFts.run(rid, fold(m.name), fold(m.description), fold(m.body));
    });

    const present = new Set<string>();
    let read = 0;
    for (let i = 0; i < names.length; i++) {
      if (i > 0 && i % YIELD_EVERY === 0) await yieldToLoop();
      const name = names[i]!;
      const id = name.slice(0, -3);
      const path = join(dir, name);
      let mtime: number;
      let size: number;
      let text: string;
      try {
        const st = await stat(path);
        if (!st.isFile()) continue;
        mtime = st.mtimeMs;
        size = st.size;
        present.add(id);
        const had = known.get(id);
        if (had && had.mtime === mtime && had.size === size) continue;
        text = await readFile(path, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          present.delete(id); // deleted between readdir and read
          continue;
        }
        throw err;
      }
      write({ id, path, mtime, size, text });
      read++;
    }

    const gone = [...known.keys()].filter((id) => !present.has(id));
    if (gone.length) {
      const find = this.db.query("SELECT rid FROM memories WHERE project_key = ? AND id = ?");
      const delRow = this.db.query("DELETE FROM memories WHERE rid = ?");
      const delVectors = this.db.query("DELETE FROM vectors WHERE project_key = ? AND id = ?");
      this.db.transaction(() => {
        for (const id of gone) {
          const row = find.get(projectKey, id) as { rid: number } | null;
          if (row) {
            dropFts.run(row.rid);
            delRow.run(row.rid);
          }
          delVectors.run(projectKey, id);
        }
      })();
    }
    return { read, removed: gone.length, total: present.size };
  }

  /** Reconciles the global folder and every `projects/<key>` folder beside the index file. */
  async reconcileAll(): Promise<void> {
    const root = dirname(this.path);
    await this.reconcile(join(root, "global"), "global", GLOBAL_MEMORY_KEY);
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await readdir(join(root, "projects"), { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    for (const e of entries) {
      if (e.isDirectory()) await this.reconcile(join(root, "projects", e.name), "project", e.name);
    }
  }

  /** The memories of the given keys, newest `updated` first; archived ones only when asked. */
  list(keys: string[], opts: { includeArchived?: boolean } = {}): MemoryIndexRow[] {
    if (!keys.length) return [];
    const rows = this.db.query(`
      SELECT * FROM memories WHERE project_key IN (${placeholders(keys.length)})
      ${opts.includeArchived ? "" : "AND archived = 0"}
      ORDER BY updated DESC, id`).all(...keys) as DbRow[];
    return rows.map(toRow);
  }

  /**
   * Full-text search over name, description and body (`bm25` weights 4, 2, 1), the query's
   * words OR-ed, archived memories left out. Scores are relative to the top hit (top = 1).
   */
  textSearch(query: string, keys: string[], limit: number): TextHit[] {
    const match = matchExpression(query);
    if (!match || !keys.length || limit <= 0) return [];
    const rows = this.db.query(`
      SELECT m.*, bm25(memories_fts, 4, 2, 1) AS rank
      FROM memories_fts JOIN memories m ON m.rid = memories_fts.rowid
      WHERE memories_fts MATCH ? AND m.archived = 0 AND m.project_key IN (${placeholders(keys.length)})
      ORDER BY rank LIMIT ?`).all(match, ...keys, limit) as (DbRow & { rank: number })[];
    const top = rows[0]?.rank ?? 0;
    return rows.map((r) => ({ ...toRow(r), score: top < 0 ? r.rank / top : 1 }));
  }

  /**
   * For every active memory of `keys` holding at least one of the query's words: the share of the
   * query it holds, each word weighted by its rarity among those memories (idf). A word no memory
   * holds weighs the most, so a query of words the store has never seen is covered by nothing, and
   * matching only "the", "for" or "in" counts for almost nothing — unlike bm25 relative to the top
   * hit, which gives the best of any match 1.0.
   */
  coverage(query: string, keys: string[]): TermCoverage[] {
    const terms = [...new Set(queryTerms(query).map((t) => t.toLowerCase()))];
    if (!terms.length || !keys.length) return [];
    const total = (this.db.query(`SELECT count(*) AS n FROM memories WHERE archived = 0 AND project_key IN (${placeholders(keys.length)})`)
      .get(...keys) as { n: number }).n;
    const hitsOf = this.db.query(`
      SELECT m.id, m.project_key FROM memories_fts JOIN memories m ON m.rid = memories_fts.rowid
      WHERE memories_fts MATCH ? AND m.archived = 0 AND m.project_key IN (${placeholders(keys.length)})`);
    const held = new Map<string, TermCoverage>();
    let weightOfAll = 0;
    for (const term of terms) {
      const hits = hitsOf.all(`"${term}"`, ...keys) as { id: string; project_key: string }[];
      const weight = Math.log(1 + total / (hits.length + 0.5));
      weightOfAll += weight;
      for (const h of hits) {
        const key = `${h.project_key}\u0000${h.id}`;
        const entry = held.get(key) ?? { projectKey: h.project_key, id: h.id, coverage: 0 };
        entry.coverage += weight;
        held.set(key, entry);
      }
    }
    return [...held.values()].map((e) => ({ ...e, coverage: weightOfAll ? e.coverage / weightOfAll : 0 }));
  }

  /** Stores (or replaces) one memory's vector for one model. */
  putVector(v: StoredVector): void {
    this.db.query(`
      INSERT OR REPLACE INTO vectors (id, scope, project_key, model, revision, dims, data)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      v.id, v.scope, v.projectKey, v.model, v.revision, v.vector.length,
      new Uint8Array(v.vector.buffer, v.vector.byteOffset, v.vector.byteLength),
    );
  }

  /** Every vector of the given keys computed by `model`; never another model's. */
  getVectors(keys: string[], model: string): StoredVector[] {
    if (!keys.length) return [];
    const rows = this.db.query(`
      SELECT id, scope, project_key, model, revision, data FROM vectors
      WHERE model = ? AND project_key IN (${placeholders(keys.length)})`).all(model, ...keys) as {
      id: string; scope: MemoryScope; project_key: string; model: string; revision: string; data: Uint8Array;
    }[];
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      projectKey: r.project_key,
      model: r.model,
      revision: r.revision,
      vector: new Float32Array(r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength)),
    }));
  }

  /** Deletes every vector of one model; returns how many. */
  deleteVectorsByModel(model: string): number {
    return this.db.query("DELETE FROM vectors WHERE model = ?").run(model).changes;
  }
}

let shared: MemoryIndex | null = null;

/**
 * The index at `memoryIndexPath()`, opened once (reopened if the PPM dir moved). When the open
 * replaced a broken file, every folder is reconciled in the background.
 */
export function getMemoryIndex(): MemoryIndex {
  const path = memoryIndexPath();
  if (shared?.path === path) return shared;
  shared?.close();
  shared = MemoryIndex.open(path);
  if (shared.brokenPath) {
    shared.reconcileAll().catch((err) => log.warn(`memory index rebuild failed: ${err instanceof Error ? err.message : String(err)}`));
  }
  return shared;
}

export function closeMemoryIndex(): void {
  shared?.close();
  shared = null;
}

/** `getMemoryIndex().reconcile(...)`. */
export function reconcile(dir: string, scope: MemoryScope, projectKey: string): Promise<ReconcileResult> {
  return getMemoryIndex().reconcile(dir, scope, projectKey);
}

/** `getMemoryIndex().textSearch(...)`. */
export function textSearch(query: string, keys: string[], limit: number): TextHit[] {
  return getMemoryIndex().textSearch(query, keys, limit);
}
