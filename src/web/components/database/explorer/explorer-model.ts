/**
 * The Database sidebar's tree as data, the way DBGate keeps it: the database the object list shows
 * (the current database) against the row picked in the tree (the focused one), which connections
 * and objects a search leaves, and in what order they are shown.
 *
 * Pure on purpose: it imports no store, so it runs under `bun:test`, where the stores read
 * `localStorage` at module scope and throw. The store and the components only call it.
 */
import { filterAllowedDatabases } from "../../../../shared/db-connection-config";
import { DB_TYPE_LABELS, type DbType } from "../../../../shared/db-types";
import type { DbColumnRef, DbObject, DbObjectKind, DbObjectList } from "../../../../shared/db-structure";

/** What the tree reads of a saved connection: its row in `GET /api/db/connections`. */
export interface TreeConnection {
  id: number;
  type: DbType;
  name: string;
  group_name: string | null;
  color: string | null;
  readonly: number;
  password_mode?: "save" | "askPassword" | "askUser";
  logged_in?: boolean;
  allowed_databases?: string[];
  allowed_databases_regex?: string | null;
  default_database?: string | null;
  single_database?: boolean;
  server?: string | null;
  user?: string | null;
}

/**
 * One database in the tree. `database` null is a connection's only one: a SQLite file, or a server
 * whose URL names none, reached without `?database=`.
 */
export interface DbRef {
  conn: number;
  database: string | null;
}

/** Shown as one database rather than a server with a list of them. */
export function isSingleDatabase(c: Pick<TreeConnection, "type" | "single_database">): boolean {
  return c.type === "sqlite" || !!c.single_database;
}

/** The database a connection's URL names (null for SQLite and for a URL naming none). */
export function ownDatabase(c: Pick<TreeConnection, "type" | "default_database">): string | null {
  return c.type === "sqlite" ? null : c.default_database ?? null;
}

/** The database a single-database connection is; null for a server, whose databases are listed under it. */
export function singleDbRef(c: TreeConnection): DbRef | null {
  return isSingleDatabase(c) ? { conn: c.id, database: ownDatabase(c) } : null;
}

export function sameDb(a: DbRef | null | undefined, b: DbRef | null | undefined): boolean {
  return !!a && !!b && a.conn === b.conn && a.database === b.database;
}

/** The key a database's objects are cached under. */
export function dbKey(ref: DbRef): string {
  return `${ref.conn}/${ref.database ?? ""}`;
}

/** The `?database=` a request about `ref` sends: none for SQLite, nor for a URL's only database. */
export function databaseParam(ref: DbRef, c: Pick<TreeConnection, "type">): string | undefined {
  return c.type === "sqlite" || ref.database === null ? undefined : ref.database;
}

/** What a tab opened on `ref` records as its `database`: nothing for the connection's own. */
export function tabDatabase(ref: DbRef, c: Pick<TreeConnection, "type" | "default_database">): string | undefined {
  return ref.database === null || ref.database === ownDatabase(c) ? undefined : ref.database;
}

/** `url` asking for `database`, or `url` itself for the connection's own. */
export function withDatabaseParam(url: string, database: string | undefined): string {
  if (database === undefined) return url;
  return `${url}${url.includes("?") ? "&" : "?"}database=${encodeURIComponent(database)}`;
}

/** Tab types that belong to a database, so the object list follows them when they are active. */
export const DB_TAB_TYPES: readonly string[] = ["database", "db-structure", "db-sql", "db-query"];

/**
 * The database the tab belongs to, or null for a tab of no database, or of a connection the list no
 * longer has. A tab records `database` only when it is not the connection's own.
 */
export function tabDbRef(
  tab: { type: string; metadata?: Record<string, unknown> } | null | undefined,
  connection: (id: number) => TreeConnection | undefined,
): DbRef | null {
  if (!tab || !DB_TAB_TYPES.includes(tab.type)) return null;
  const id = tab.metadata?.connectionId;
  if (typeof id !== "number") return null;
  const conn = connection(id);
  if (!conn) return null;
  const database = tab.metadata?.database;
  if (typeof database === "string" && database && conn.type !== "sqlite") return { conn: id, database };
  return { conn: id, database: ownDatabase(conn) };
}

/**
 * Whether the tree shows its question instead of the object list: the focused row is another
 * connection, or another database of the same one. Focusing a server itself (database null) keeps
 * the list of whichever of its databases is current.
 */
export function focusDiffers(focused: DbRef | null, current: DbRef | null, connectionExists: (id: number) => boolean): boolean {
  if (!focused || !connectionExists(focused.conn)) return false;
  if (!current) return true;
  return focused.conn !== current.conn || (focused.database !== null && focused.database !== current.database);
}

/**
 * The connection whose state the object list shows: the one its prompt asks about while the
 * picked row is not the current database, else the current database's. A failure of that
 * connection — a missing driver's Install with it — is shown there, and not under its row too.
 */
export function connectionShownBelow(focused: DbRef | null, current: DbRef | null, connectionExists: (id: number) => boolean): number | null {
  if (focusDiffers(focused, current, connectionExists)) return focused!.conn;
  return current && connectionExists(current.conn) ? current.conn : null;
}

/** A server connection's databases, less those its Advanced tab hides. */
export function visibleDatabases(c: TreeConnection, names: readonly string[]): string[] {
  return filterAllowedDatabases(names, {
    allowedDatabases: c.allowed_databases,
    allowedDatabasesRegex: c.allowed_databases_regex ?? undefined,
  });
}

// ─── Searching connections ───────────────────────────────────────────────────

export type ConnectionSearchField = "name" | "server" | "user" | "engine" | "database";

export const CONNECTION_SEARCH_FIELDS: { field: ConnectionSearchField; label: string }[] = [
  { field: "name", label: "Display name" },
  { field: "server", label: "Server" },
  { field: "user", label: "User" },
  { field: "engine", label: "Database engine" },
  { field: "database", label: "Database name" },
];

export const DEFAULT_CONNECTION_SEARCH: ConnectionSearchField[] = ["name", "database"];

/** The name the tree shows for a single-database connection's database. */
export function singleDatabaseName(c: TreeConnection): string {
  if (c.type !== "sqlite") return c.default_database ?? "";
  const path = c.server ?? "";
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

export interface ConnectionMatch {
  show: boolean;
  /** While searching, the databases listed under the connection: the ones that matched, when it did not itself. */
  databases: string[] | null;
}

/** Whether `c` is left by a search, and which of its (listed) databases are. */
export function matchConnection(
  c: TreeConnection,
  query: string,
  fields: readonly ConnectionSearchField[],
  databases: readonly string[] | undefined,
): ConnectionMatch {
  const q = query.trim().toLowerCase();
  if (!q) return { show: true, databases: null };
  const by = new Set(fields);
  const has = (s: string | null | undefined) => !!s && s.toLowerCase().includes(q);
  const hit = (by.has("name") && has(c.name))
    || (by.has("server") && has(c.server))
    || (by.has("user") && has(c.user))
    || (by.has("engine") && has(DB_TYPE_LABELS[c.type]));
  const single = isSingleDatabase(c);
  const singleHit = by.has("database") && single && has(singleDatabaseName(c));
  const dbs = by.has("database") && !single && databases ? databases.filter((d) => has(d)) : [];
  return { show: hit || singleHit || dbs.length > 0, databases: dbs.length > 0 && !hit ? dbs : null };
}

/** Folder names, sorted: the ones connections are in, and the empty ones made in the tree. */
export function folderNames(conns: readonly TreeConnection[], emptyFolders: readonly string[]): string[] {
  const names = new Set<string>();
  for (const c of conns) if (c.group_name) names.add(c.group_name);
  for (const f of emptyFolders) names.add(f);
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** What the tree's tooltip on a connection says: where it connects, as whom. */
export function connectionWhere(c: TreeConnection): string {
  if (c.type === "sqlite") return c.server ?? "";
  const at = c.server ? `${c.user ? `${c.user}@` : ""}${c.server}` : "";
  return `${at}${c.default_database ? `/${c.default_database}` : ""}`;
}

// ─── Objects of the current database ─────────────────────────────────────────

export const OBJECT_GROUPS: { kind: DbObjectKind; label: string; one: string }[] = [
  { kind: "table", label: "Tables", one: "table" },
  { kind: "view", label: "Views", one: "view" },
  { kind: "matview", label: "Materialized views", one: "materialized view" },
  { kind: "procedure", label: "Procedures", one: "procedure" },
  { kind: "function", label: "Functions", one: "function" },
  { kind: "trigger", label: "Triggers", one: "trigger" },
  { kind: "sequence", label: "Sequences", one: "sequence" },
];

/** Kinds whose rows can be opened and whose columns can be listed. */
export const KINDS_WITH_COLUMNS: ReadonlySet<DbObjectKind> = new Set(["table", "view", "matview"]);

/** Postgres is the one engine the tree offers a schema choice for: in MySQL a database is its schema. */
export function hasSchemaChoice(type: DbType): boolean {
  return type === "postgres";
}

export interface SchemaOption {
  schema: string;
  count: number;
}

export function schemaOptions(list: DbObjectList): SchemaOption[] {
  const counts = new Map<string, number>();
  for (const o of list.objects) if (o.schema !== null) counts.set(o.schema, (counts.get(o.schema) ?? 0) + 1);
  const names = new Set([...list.schemas, ...counts.keys()]);
  return [...names].sort((a, b) => a.localeCompare(b)).map((schema) => ({ schema, count: counts.get(schema) ?? 0 }));
}

/** The schema the list opens on: the one picked before if it still exists, else `public`, else the first with objects. */
export function initialSchema(options: readonly SchemaOption[], remembered: string | undefined): string | null {
  if (remembered && options.some((o) => o.schema === remembered)) return remembered;
  if (options.some((o) => o.schema === "public")) return "public";
  return (options.find((o) => o.count > 0) ?? options[0])?.schema ?? null;
}

export type ObjectSearchField = "name" | "schema" | "column" | "type";

export const DEFAULT_OBJECT_SEARCH: ObjectSearchField[] = ["name"];

export type ObjectSort = "name" | "rows";

export interface ObjectFilter {
  query: string;
  fields: readonly ObjectSearchField[];
  /** Columns by `schema.table` (`.table` without a schema), when searching by column. */
  columns?: ReadonlyMap<string, readonly DbColumnRef[]>;
  onlyWithRows: boolean;
  sort: ObjectSort;
}

export interface ObjectGroup {
  kind: DbObjectKind;
  label: string;
  items: DbObject[];
}

export function tableKeyOf(schema: string | null, name: string): string {
  return `${schema ?? ""}.${name}`;
}

export function columnsByTable(columns: readonly DbColumnRef[]): Map<string, DbColumnRef[]> {
  const map = new Map<string, DbColumnRef[]>();
  for (const c of columns) {
    const key = tableKeyOf(c.schema, c.table);
    const list = map.get(key);
    if (list) list.push(c);
    else map.set(key, [c]);
  }
  return map;
}

/** Whether the search needs every column of the database, which is read only then. */
export function searchNeedsColumns(filter: Pick<ObjectFilter, "query" | "fields">): boolean {
  return !!filter.query.trim() && (filter.fields.includes("column") || filter.fields.includes("type"));
}

/** Columns of `o` the search matched by name, for listing them under it opened. */
export function matchingColumns(o: DbObject, filter: ObjectFilter): DbColumnRef[] {
  const q = filter.query.trim().toLowerCase();
  if (!q || !filter.fields.includes("column")) return [];
  return (filter.columns?.get(tableKeyOf(o.schema, o.name)) ?? []).filter((c) => c.name.toLowerCase().includes(q));
}

function objectMatches(o: DbObject, q: string, filter: ObjectFilter): boolean {
  const by = filter.fields;
  if (by.includes("name") && o.name.toLowerCase().includes(q)) return true;
  if (by.includes("schema") && o.schema?.toLowerCase().includes(q)) return true;
  if (!by.includes("column") && !by.includes("type")) return false;
  const cols = filter.columns?.get(tableKeyOf(o.schema, o.name)) ?? [];
  return cols.some((c) => (by.includes("column") && c.name.toLowerCase().includes(q)) || (by.includes("type") && c.type.toLowerCase().includes(q)));
}

/**
 * The groups the list shows — Tables, Views, … in DBGate's order, empty ones left out — with what
 * the search, "only tables with rows" and the sort leave in each. `schema` null takes every object
 * (engines without a schema choice).
 */
export function groupObjects(list: DbObjectList, schema: string | null, filter: ObjectFilter): ObjectGroup[] {
  const q = filter.query.trim().toLowerCase();
  const inSchema = schema === null ? list.objects : list.objects.filter((o) => o.schema === schema);
  const byName = (a: DbObject, b: DbObject) => a.name.localeCompare(b.name) || (a.args ?? "").localeCompare(b.args ?? "");
  const byRows = (a: DbObject, b: DbObject) => (b.rowEstimate ?? -1) - (a.rowEstimate ?? -1) || byName(a, b);
  const groups: ObjectGroup[] = [];
  for (const { kind, label } of OBJECT_GROUPS) {
    let items = inSchema.filter((o) => o.kind === kind && (!q || objectMatches(o, q, filter)));
    // An engine that keeps no row statistics cannot say a table is empty, so it is not hidden.
    if (filter.onlyWithRows && kind === "table") items = items.filter((o) => o.rowEstimate === undefined || o.rowEstimate > 0);
    if (items.length === 0) continue;
    groups.push({ kind, label, items: items.sort(filter.sort === "rows" ? byRows : byName) });
  }
  return groups;
}

/** Objects per schema, for the schema choice: `public (25)`. */
export function countObjects(list: DbObjectList, schema: string | null): number {
  return schema === null ? list.objects.length : list.objects.filter((o) => o.schema === schema).length;
}

/** An engine's row estimate, short: `~5.2k`, `~12k`, `~1.3M`; small counts as they are. */
export function formatRowEstimate(n: number): string {
  if (n >= 1e6) return `~${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `~${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `~${(n / 1e3).toFixed(1)}k`;
  if (n >= 100) return `~${n}`;
  return String(n);
}

/** `text` cut around the first match of `query`, for marking it; null when nothing matches. */
export function highlightParts(text: string, query: string): [string, string, string] | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const i = text.toLowerCase().indexOf(needle);
  if (i < 0) return null;
  return [text.slice(0, i), text.slice(i, i + needle.length), text.slice(i + needle.length)];
}

/** The key an object row's expansion (its columns shown) is remembered under. */
export function objectNodeKey(ref: DbRef, o: Pick<DbObject, "schema" | "name">): string {
  return `${dbKey(ref)}|${tableKeyOf(o.schema, o.name)}`;
}

/** The connection id an object node key belongs to, for forgetting deleted connections. */
export function connOfNodeKey(key: string): number {
  return Number(key.slice(0, key.indexOf("/")));
}
