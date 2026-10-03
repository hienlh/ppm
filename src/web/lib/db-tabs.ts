/**
 * Database tabs as data. Every one of them talks to a target: a saved connection — one of its
 * server's databases when `database` is set — or a SQLite file opened by its path, which the server
 * serves under the connection id `file` and checks again on every request
 * (`src/services/database/file-database.ts`). This file builds their URLs, their ids — so a table,
 * its structure, one object's SQL or a query lands on one tab however it was opened — and the
 * upgrade of tabs saved before these types existed.
 *
 * Pure: it imports no store, so it runs under `bun:test`.
 */
import { randomId } from "@/lib/utils";
import { isStructureTabDirty } from "@/lib/db-table-edit";
import type { DbObjectKind } from "../../shared/db-structure";

export type DbTarget =
  | { kind: "connection"; connectionId: number; database?: string }
  | { kind: "file"; path: string; projectName?: string };

export type DbTabType = "database" | "db-structure" | "db-sql" | "db-query";

/** The scripts a SQL tab can show, and open in a Query tab. */
export type DbScriptKind = "create" | "select" | "insert";

/** The `:id` the server serves a database file under (`FILE_CONNECTION_ID`). */
const FILE_CONNECTION_ID = "file";

const OBJECT_KINDS: ReadonlySet<string> = new Set<DbObjectKind>(["table", "view", "matview", "function", "procedure", "trigger", "sequence"]);

/** Tables, views and materialized views share one namespace in every engine, so one id covers whichever it is. */
const RELATION_KINDS: ReadonlySet<string> = new Set<DbObjectKind>(["table", "view", "matview"]);

/** A saved connection's id, also as the digits an older tab or a URL may hold it as. */
function connectionIdOf(value: unknown): number | null {
  const id = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
}

/** The target a tab's metadata names, or null for one naming none. */
export function targetOf(metadata: Record<string, unknown> | undefined): DbTarget | null {
  const file = metadata?.dbFile;
  if (file && typeof file === "object") {
    const { path, projectName } = file as Record<string, unknown>;
    if (typeof path !== "string" || !path) return null;
    return { kind: "file", path, ...(typeof projectName === "string" && projectName ? { projectName } : {}) };
  }
  const id = connectionIdOf(metadata?.connectionId);
  if (id === null) return null;
  const database = metadata?.database;
  return { kind: "connection", connectionId: id, ...(typeof database === "string" && database ? { database } : {}) };
}

/** The metadata fields that name `t` on a tab. */
export function targetFields(t: DbTarget): Record<string, unknown> {
  return t.kind === "file"
    ? { dbFile: { path: t.path, ...(t.projectName ? { projectName: t.projectName } : {}) } }
    : { connectionId: t.connectionId, ...(t.database ? { database: t.database } : {}) };
}

export function sameTarget(a: DbTarget | null, b: DbTarget | null): boolean {
  if (!a || !b) return false;
  if (a.kind === "file") return b.kind === "file" && a.path === b.path && (a.projectName ?? "") === (b.projectName ?? "");
  return b.kind === "connection" && a.connectionId === b.connectionId && (a.database ?? "") === (b.database ?? "");
}

/**
 * `/api/db/connections/<id><path>` for `t`: a saved connection's with its `?database=`, a file's
 * under the id `file` with its `?path=` and `?project=`. `path` may carry a query string of its own.
 */
export function targetUrl(t: DbTarget, path = ""): string {
  const url = `/api/db/connections/${t.kind === "file" ? FILE_CONNECTION_ID : t.connectionId}${path}`;
  const params: [string, string][] = t.kind === "file"
    ? [["path", t.path], ...(t.projectName ? [["project", t.projectName] as [string, string]] : [])]
    : t.database !== undefined ? [["database", t.database]] : [];
  if (params.length === 0) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
}

/** A file's name, which a tab on it shows where a saved connection's tab shows the connection's. */
export function fileDisplayName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1) || path;
}

/** What a tab calls where it is: the connection's name — or the file's — then the database when it is not the connection's own. */
export function targetLabel(t: DbTarget | null, connectionName: string | undefined): string {
  const name = t?.kind === "file" ? fileDisplayName(t.path) : connectionName ?? "Database";
  return t?.kind === "connection" && t.database ? `${name}/${t.database}` : name;
}

/** A tab's title for one table: where it is, then the table. The Structure and SQL tabs share it, as DBGate's do; their icons tell them apart. */
export function dbObjectTabTitle(t: DbTarget | null, connectionName: string | undefined, name: string): string {
  return `${targetLabel(t, connectionName)} · ${name}`;
}

// ─── Ids ─────────────────────────────────────────────────────────────────────

const part = (v: unknown) => encodeURIComponent(typeof v === "string" ? v : "");

/**
 * The part of a tab id naming its target — `<connectionId>:<database>`, or `file:<project>:<path>` —
 * and the key what is kept per target is kept under.
 */
export function targetKey(t: DbTarget | null): string {
  if (!t) return "default:";
  return t.kind === "file" ? `file:${part(t.projectName)}:${part(t.path)}` : `${t.connectionId}:${part(t.database)}`;
}

/**
 * One tab per table's data, per table's structure and per object's SQL, as DBGate keys them — the
 * target, the schema and the name, every part URI-encoded so none holds the `:` between them. A
 * query tab is its own, whatever it runs against, and so is a table's data opened with an
 * `instance`: the row a foreign key refers to, which DBGate always opens in a new tab.
 */
export function dbTabId(type: DbTabType, m: Record<string, unknown> | undefined): string {
  if (type === "db-query") return `db-query:${part(m?.queryId) || randomId()}`;
  // A table not created yet has no name to key it by; each New table is a tab of its own.
  if (type === "db-structure" && typeof m?.newTableId === "string" && m.newTableId) return `db-structure:new:${part(m.newTableId)}`;
  const where = targetKey(targetOf(m));
  const schema = part(m?.schemaName);
  if (type === "db-sql") {
    const kind = typeof m?.objectKind === "string" && RELATION_KINDS.has(m.objectKind) ? "table" : part(m?.objectKind);
    return `db-sql:${where}:${schema}:${kind}:${part(m?.objectName)}:${part(m?.objectArgs)}:${part(m?.objectTable)}`;
  }
  const instance = type === "database" && typeof m?.instance === "string" && m.instance ? `:${part(m.instance)}` : "";
  return `${type}:${where}:${schema}:${part(m?.tableName)}${instance}`;
}

function decodePart(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * The metadata a tab id stands for, read back out of a URL (`/project/<p>/<type>/<rest of the id>`);
 * null for one that names nothing to open. A query tab cannot be rebuilt from its id: its SQL is not in it,
 * nor a New table's (`db-structure:new:…`), whose table exists only in the tab.
 */
export function dbTabMetadataFromId(type: DbTabType, identifier: string): Record<string, unknown> | null {
  if (type === "db-query") return null;
  const parts = identifier.split(":").map(decodePart);
  if (parts.some((p) => p === null)) return null;
  const [first = "", ...rest] = parts as string[];
  let target: DbTarget;
  let tail: string[];
  if (first === FILE_CONNECTION_ID) {
    const [projectName = "", path = "", ...more] = rest;
    if (!path) return null;
    target = { kind: "file", path, ...(projectName ? { projectName } : {}) };
    tail = more;
  } else {
    const id = connectionIdOf(first);
    if (id === null) return null;
    const [database = "", ...more] = rest;
    target = { kind: "connection", connectionId: id, ...(database ? { database } : {}) };
    tail = more;
  }
  if (type === "db-sql") {
    const [schemaName = "", objectKind = "", objectName = "", objectArgs = "", objectTable = ""] = tail;
    if (!OBJECT_KINDS.has(objectKind) || !objectName) return null;
    const routine = objectKind === "function" || objectKind === "procedure";
    return {
      ...targetFields(target), schemaName, objectKind, objectName,
      ...(routine ? { objectArgs } : {}), ...(objectTable ? { objectTable } : {}),
    };
  }
  const [schemaName = "", tableName = "", instance = ""] = tail;
  if (!tableName) return null;
  return { ...targetFields(target), schemaName, tableName, ...(type === "database" && instance ? { instance } : {}) };
}

// ─── Query tabs ──────────────────────────────────────────────────────────────

/** What a new query tab holds: `sql` in its editor, `run` when opening it should also run it. */
export function queryTabMetadata(sql: string, queryNumber: number, opts: { run?: boolean } = {}): Record<string, unknown> {
  return { queryId: randomId(), queryNumber, currentSql: sql, openedSql: sql, ...(opts.run ? { runOnOpen: true } : {}) };
}

/** The tab holds SQL typed since it opened or was last saved, which nothing else keeps: DBGate's unsaved dot. */
export function isQueryTabDirty(m: Record<string, unknown> | undefined): boolean {
  if (typeof m?.currentSql !== "string") return false;
  return m.currentSql !== (typeof m.openedSql === "string" ? m.openedSql : "");
}

/** DBGate's unsaved dot, on whichever database tab holds work nothing else keeps. */
export function isDbTabDirty(type: string, m: Record<string, unknown> | undefined): boolean {
  if (type === "db-query") return isQueryTabDirty(m);
  if (type === "db-structure") return isStructureTabDirty(m);
  return false;
}

/** The next "Query N": one past the highest a tab already has, as DBGate numbers them. */
export function nextQueryNumber(tabs: Iterable<{ type: string; metadata?: Record<string, unknown> }>): number {
  let max = 0;
  for (const tab of tabs) {
    const n = tab.type === "db-query" ? tab.metadata?.queryNumber : undefined;
    if (typeof n === "number" && n > max) max = n;
  }
  return max + 1;
}

// ─── Tabs saved by older versions ────────────────────────────────────────────

interface StoredTab {
  id: string;
  type: string;
  metadata?: Record<string, unknown>;
}

/** The fields of a tab that say where it is, carried over when it changes type. */
function identityOf(m: Record<string, unknown>): Record<string, unknown> {
  const id = connectionIdOf(m.connectionId);
  const keep: Record<string, unknown> = {};
  for (const k of ["connectionName", "dbType", "connectionColor", "database", "dbFile"]) if (m[k] !== undefined) keep[k] = m[k];
  return { ...keep, ...(id !== null ? { connectionId: id } : {}) };
}

function asQuery(m: Record<string, unknown>): { type: "db-query"; metadata: Record<string, unknown> } {
  const sql = typeof m.currentSql === "string" ? m.currentSql : typeof m.initialSql === "string" ? m.initialSql : "";
  return {
    type: "db-query",
    metadata: {
      ...identityOf(m),
      queryId: typeof m.queryId === "string" && m.queryId ? m.queryId : randomId(),
      ...(typeof m.queryNumber === "number" ? { queryNumber: m.queryNumber } : {}),
      // Kept as it was, so it opens clean: what an older tab held was its own to keep.
      currentSql: sql, openedSql: sql,
    },
  };
}

/**
 * A tab saved before the Structure, SQL and Query tabs existed, as it opens now — or null for one
 * that cannot be opened any more. The `@panel` suffix of a tab opened in a second panel is kept.
 *
 * - `database` with no table (a query, or a connection opened with nothing picked) → `db-query`,
 *   with its SQL;
 * - `postgres` or `sqlite` on a saved connection (the old sidebar's tabs) → that table's `database`
 *   tab, or a `db-query` when no table was open;
 * - `postgres` on no saved connection is dropped: it named its server by a connection string, which
 *   no tab keeps any more;
 * - `sqlite` on a file stays, as the file's own tab; one on neither is dropped.
 */
export function upgradeDbTab<T extends StoredTab>(tab: T): T | null {
  const m = tab.metadata ?? {};
  const suffix = tab.id.includes("@") ? tab.id.slice(tab.id.indexOf("@")) : "";
  const hasTable = typeof m.tableName === "string" && m.tableName !== "";
  let next: { type: DbTabType; metadata: Record<string, unknown> } | null;

  if (tab.type === "database") {
    if (!hasTable) {
      next = asQuery(m);
    } else {
      // A URL used to open one with the id as a string, which matches no connection.
      const id = connectionIdOf(m.connectionId);
      if (id === null || id === m.connectionId) return tab;
      next = { type: "database", metadata: { ...m, connectionId: id } };
    }
  } else if (tab.type === "postgres" || tab.type === "sqlite") {
    if (connectionIdOf(m.connectionId) === null) {
      if (tab.type === "sqlite" && typeof m.filePath === "string" && m.filePath) return tab;
      return null;
    }
    const dbType = m.dbType ?? tab.type;
    next = hasTable
      ? { type: "database", metadata: { ...identityOf(m), dbType, schemaName: typeof m.schemaName === "string" ? m.schemaName : "", tableName: m.tableName } }
      : { type: "db-query", metadata: { ...asQuery(m).metadata, dbType } };
  } else {
    return tab;
  }
  return { ...tab, id: `${dbTabId(next.type, next.metadata)}${suffix}`, type: next.type, metadata: next.metadata };
}
