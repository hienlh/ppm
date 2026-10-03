/**
 * Turn a changeset into the statements that apply it, for one dialect.
 *
 * Statements come out in DBGate's order — the ticked cascade deletes, then
 * inserts, updates, deletes — each with parameters for the driver and a
 * written-out copy for the Save dialog and the audit log. An UPDATE or DELETE
 * addresses its row by key and is marked `expectOne`: the adapter runs the
 * lot in one transaction and gives up on the first statement that does not hit
 * exactly one row, so an edit can never spread to rows nobody saw.
 */
import {
  CHANGESET_MAX_OPERATIONS,
  type ChangesetDelete, type ChangesetFailure, type ChangesetReference, type ChangesetUpdate, type RowKey, type TableRef,
} from "../../shared/db-changeset.ts";
import type { DbBinaryValue } from "../../shared/db-grid.ts";
import { tableKey, type DbForeignKey } from "../../shared/db-structure.ts";
import type { ChangesetStatement } from "../../types/database.ts";
import type { DialectColumn, SqlDialect } from "./dialect.ts";

/** A changeset that cannot be turned into SQL. Maps to HTTP 400. */
export class ChangesetRequestError extends Error {
  readonly status = 400;
}

export interface ValidChangeset {
  table: string;
  schema: string | null;
  inserts: Record<string, unknown>[];
  updates: ChangesetUpdate[];
  deletes: ChangesetDelete[];
  cascade: TableRef[];
}

/** The table a changeset writes to, as the catalog describes it. */
export interface ChangesetTable {
  schema: string | null;
  name: string;
  columns: DialectColumn[];
  /** Names that reach SQLite's rowid; a key may use one in place of a column. */
  rowidAliases: string[];
}

export type { ChangesetStatement };

/** Deleted keys per cascade statement, so one statement never carries tens of thousands of parameters. */
const CASCADE_KEYS_PER_STATEMENT = 500;
/** Cascade discovery stops here; a schema this tangled needs a person to look at it. */
const MAX_CASCADE_PATHS = 200;
const MAX_CASCADE_DEPTH = 10;

function fail(message: string): never {
  throw new ChangesetRequestError(message);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function parseKey(raw: unknown, what: string): RowKey {
  if (!isRecord(raw) || Object.keys(raw).length === 0) fail(`${what} needs a key`);
  return raw;
}

function parseTableRef(raw: unknown, defaultSchema: string | null): TableRef {
  if (!isRecord(raw) || typeof raw.table !== "string" || !raw.table) fail("Every cascade entry needs a table");
  const schema = typeof raw.schema === "string" && raw.schema ? raw.schema : defaultSchema;
  return { schema, table: raw.table };
}

/** Check the shape of a request body; column names are checked against the table later. */
export function parseChangeset(body: unknown, defaultSchema: string | null): ValidChangeset {
  if (!isRecord(body)) fail("Request body must be an object");
  if (typeof body.table !== "string" || !body.table) fail("table is required");
  if (body.schema !== undefined && body.schema !== null && typeof body.schema !== "string") fail("schema must be text");
  const list = (name: string): unknown[] => {
    const v = body[name];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) fail(`${name} must be a list`);
    return v;
  };
  const inserts = list("inserts").map((row, i) => {
    if (!isRecord(row)) fail(`Insert ${i + 1} must be an object of column values`);
    return row;
  });
  const updates = list("updates").map((u, i): ChangesetUpdate => {
    if (!isRecord(u)) fail(`Update ${i + 1} must be an object`);
    if (!isRecord(u.set) || Object.keys(u.set).length === 0) fail(`Update ${i + 1} sets no column`);
    if (u.original !== undefined && !isRecord(u.original)) fail(`Update ${i + 1}: original must be an object`);
    return { key: parseKey(u.key, `Update ${i + 1}`), set: u.set, ...(u.original ? { original: u.original as Record<string, unknown> } : {}) };
  });
  const deletes = list("deletes").map((d, i): ChangesetDelete => {
    if (!isRecord(d)) fail(`Delete ${i + 1} must be an object`);
    return { key: parseKey(d.key, `Delete ${i + 1}`) };
  });
  if (inserts.length + updates.length + deletes.length > CHANGESET_MAX_OPERATIONS) {
    fail(`A changeset may hold at most ${CHANGESET_MAX_OPERATIONS} changes; save in smaller batches`);
  }
  const schema = typeof body.schema === "string" && body.schema ? body.schema : defaultSchema;
  return {
    table: body.table,
    schema,
    inserts,
    updates,
    deletes,
    // A cascade entry without a schema means the changeset's own.
    cascade: list("cascade").map((ref) => parseTableRef(ref, schema)),
  };
}

function isBinaryValue(x: unknown): x is DbBinaryValue {
  return isRecord(x) && typeof x.$binary === "string" && typeof x.size === "number";
}

/**
 * A JSON value from the browser as the driver should receive it. Bytes come
 * back from their `$binary` marker; SQLite has no JSON type, so objects are
 * stored as their JSON text, as is anything written to a Postgres JSON column.
 */
function paramValue(d: SqlDialect, col: DialectColumn, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (isBinaryValue(value)) {
    if (value.truncated) fail(`"${col.name}" holds a value that was only partly loaded, so it cannot be used to find or write the row`);
    return new Uint8Array(Buffer.from(value.$binary, "base64"));
  }
  if (d.name === "sqlite") {
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "object") return JSON.stringify(value);
    return value;
  }
  if (col.kind === "json" && typeof value !== "string") return JSON.stringify(value);
  return value;
}

/**
 * Whether a value read back from the grid still compares equal to what the
 * database holds. JSON, binary, arrays and the like do not round-trip through
 * the browser byte for byte, Postgres floats did not print exactly before
 * version 12, and a MySQL FLOAT is shown shortened from its float32 value —
 * comparing those would refuse saves nobody raced.
 */
function comparable(d: SqlDialect, col: DialectColumn, value: unknown): boolean {
  if (value !== null && typeof value === "object") return false;
  if (d.name === "sqlite") return col.kind !== "json" && col.kind !== "binary";
  if (col.kind === "number") return !/^(real|double|float)/i.test(col.type);
  return ["text", "boolean", "date", "datetime", "datetimetz", "time"].includes(col.kind);
}

/** Collects parameters for one statement and writes the literal copy beside it. */
class StatementWriter {
  readonly params: unknown[] = [];
  constructor(private readonly d: SqlDialect) {}

  /** A value bound for execution, and the same value written out for display. */
  value(col: DialectColumn, raw: unknown): { exec: string; display: string } {
    const v = paramValue(this.d, col, raw);
    this.params.push(v);
    const placeholder = this.d.placeholder(this.params.length);
    return { exec: this.d.bindAs(placeholder, col, v), display: this.d.literal(v, col.kind) };
  }
}

interface Fragment { exec: string; display: string }

function join(parts: Fragment[], sep: string): Fragment {
  return { exec: parts.map((p) => p.exec).join(sep), display: parts.map((p) => p.display).join(sep) };
}

export class ChangesetBuilder {
  private readonly byName: Map<string, DialectColumn>;

  constructor(private readonly d: SqlDialect, private readonly table: ChangesetTable) {
    this.byName = new Map(table.columns.map((c) => [c.name, c]));
  }

  private get target(): string {
    return this.d.qualify(this.table.name, this.table.schema);
  }

  private column(name: string): DialectColumn {
    return this.byName.get(name) ?? fail(`Table "${this.table.name}" has no column "${name}"`);
  }

  private keyColumn(name: string): DialectColumn {
    if (!this.byName.has(name) && this.table.rowidAliases.includes(name.toLowerCase())) {
      return { name, type: "INTEGER", kind: "number" };
    }
    return this.column(name);
  }

  /** `k1 = $1 AND k2 = $2`, with IS NULL for a missing value (SQLite allows NULL in a non-integer key). */
  private keyCondition(w: StatementWriter, key: RowKey): Fragment {
    return join(Object.entries(key).map(([name, raw]) => {
      const col = this.keyColumn(name);
      const c = this.d.quoteIdent(col.name);
      if (raw === null || raw === undefined) return { exec: `${c} IS NULL`, display: `${c} IS NULL` };
      const v = w.value(col, raw);
      return { exec: `${c} = ${v.exec}`, display: `${c} = ${v.display}` };
    }), " AND ");
  }

  insert(values: Record<string, unknown>): ChangesetStatement {
    const w = new StatementWriter(this.d);
    const names = Object.keys(values);
    if (names.length === 0) {
      const sql = this.d.insertDefaultValues(this.target);
      return { sql, params: [], displaySql: sql, kind: "insert", expectOne: false };
    }
    const cols = names.map((n) => this.column(n));
    const vals = join(cols.map((c) => w.value(c, values[c.name])), ", ");
    const head = `INSERT INTO ${this.target} (${cols.map((c) => this.d.quoteIdent(c.name)).join(", ")}) VALUES `;
    return { sql: `${head}(${vals.exec})`, params: w.params, displaySql: `${head}(${vals.display})`, kind: "insert", expectOne: false };
  }

  update(u: ChangesetUpdate): ChangesetStatement {
    const w = new StatementWriter(this.d);
    const sets = join(Object.entries(u.set).map(([name, raw]) => {
      const col = this.column(name);
      const v = w.value(col, raw);
      const c = this.d.quoteIdent(col.name);
      return { exec: `${c} = ${v.exec}`, display: `${c} = ${v.display}` };
    }), ", ");
    const conditions = [this.keyCondition(w, u.key)];
    for (const [name, raw] of Object.entries(u.original ?? {})) {
      // Only the columns being changed are checked: a concurrent edit to
      // another column of the same row is not lost by this one.
      if (!(name in u.set)) continue;
      const col = this.column(name);
      if (!comparable(this.d, col, raw)) continue;
      const v = w.value(col, raw);
      const c = this.d.quoteIdent(col.name);
      conditions.push({ exec: this.d.nullSafeEquals(c, v.exec), display: this.d.nullSafeEquals(c, v.display) });
    }
    const where = join(conditions, " AND ");
    const head = `UPDATE ${this.target} SET `;
    return {
      sql: `${head}${sets.exec} WHERE ${where.exec}`,
      params: w.params,
      displaySql: `${head}${sets.display} WHERE ${where.display}`,
      kind: "update",
      expectOne: true,
    };
  }

  /**
   * The value `column` holds in the row `key` names, read whole: Save cell to file's read. It asks
   * for two rows, so that a key naming more than one row is found out rather than read from.
   */
  selectCell(column: string, key: RowKey): { sql: string; params: unknown[]; displaySql: string } {
    const w = new StatementWriter(this.d);
    const head = `SELECT ${this.d.quoteIdent(this.column(column).name)} FROM ${this.target} WHERE `;
    const where = this.keyCondition(w, key);
    return { sql: `${head}${where.exec} LIMIT 2`, params: w.params, displaySql: `${head}${where.display} LIMIT 2` };
  }

  delete(key: RowKey): ChangesetStatement {
    const w = new StatementWriter(this.d);
    const where = this.keyCondition(w, key);
    const head = `DELETE FROM ${this.target} WHERE `;
    return { sql: head + where.exec, params: w.params, displaySql: head + where.display, kind: "delete", expectOne: true };
  }

  /**
   * DELETE the rows of the path's last table that lead, key by key, to one of
   * `keys` in this table. Each step is an IN over the step before, so no
   * table on the way needs a primary key of its own.
   */
  cascade(path: DbForeignKey[], keys: RowKey[]): ChangesetStatement {
    const w = new StatementWriter(this.d);
    const tuple = (names: string[]) => {
      const quoted = names.map((n) => this.d.quoteIdent(n));
      return quoted.length === 1 ? quoted[0]! : `(${quoted.join(", ")})`;
    };
    const rowsOfThis = join(keys.map((k) => {
      const c = this.keyCondition(w, k);
      return keys.length === 1 ? c : { exec: `(${c.exec})`, display: `(${c.display})` };
    }), " OR ");
    let inner: Fragment = {
      exec: `SELECT ${path[0]!.refColumns.map((n) => this.d.quoteIdent(n)).join(", ")} FROM ${this.target} WHERE ${rowsOfThis.exec}`,
      display: `SELECT ${path[0]!.refColumns.map((n) => this.d.quoteIdent(n)).join(", ")} FROM ${this.target} WHERE ${rowsOfThis.display}`,
    };
    for (let i = 1; i < path.length; i++) {
      const via = path[i - 1]!;
      const next = path[i]!;
      const from = `SELECT ${next.refColumns.map((n) => this.d.quoteIdent(n)).join(", ")} FROM ${this.d.qualify(via.table, via.schema)} WHERE ${tuple(via.columns)} IN `;
      inner = { exec: `${from}(${inner.exec})`, display: `${from}(${inner.display})` };
    }
    const last = path[path.length - 1]!;
    const head = `DELETE FROM ${this.d.qualify(last.table, last.schema)} WHERE ${tuple(last.columns)} IN `;
    return { sql: `${head}(${inner.exec})`, params: w.params, displaySql: `${head}(${inner.display})`, kind: "cascade", expectOne: false };
  }
}

/** Keys equal as JSON name the same row; the grid never sends two spellings of one value. */
function keyId(key: RowKey): string {
  return JSON.stringify(Object.keys(key).sort().map((k) => [k, key[k]]));
}

/**
 * Two updates to one row become one (a later value wins, the first original
 * stays), and a row deleted twice is deleted once — otherwise the second
 * statement finds nothing and the save fails on its own duplicate.
 */
function mergeUpdates(updates: ChangesetUpdate[]): ChangesetUpdate[] {
  const byKey = new Map<string, ChangesetUpdate>();
  for (const u of updates) {
    const id = keyId(u.key);
    const prev = byKey.get(id);
    if (!prev) { byKey.set(id, { key: u.key, set: { ...u.set }, original: { ...(u.original ?? {}) } }); continue; }
    Object.assign(prev.set, u.set);
    for (const [k, v] of Object.entries(u.original ?? {})) if (!(k in prev.original!)) prev.original![k] = v;
  }
  return [...byKey.values()];
}

function uniqueDeletes(deletes: ChangesetDelete[]): ChangesetDelete[] {
  const seen = new Set<string>();
  return deletes.filter((d) => {
    const id = keyId(d.key);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** One chain of foreign keys from a referencing table back to the table rows are deleted from; `path[0]` points at it. */
export interface CascadePath {
  fks: DbForeignKey[];
}

/**
 * Every chain of foreign keys that ends at `table`, walked outwards from it.
 * A table already on a chain is not entered again, which is what stops a
 * cycle — and leaves out a table's keys to itself, as DBGate does.
 */
export function findCascadePaths(allKeys: DbForeignKey[], table: TableRef): CascadePath[] {
  const incoming = new Map<string, DbForeignKey[]>();
  for (const fk of allKeys) {
    const k = tableKey(fk.refSchema, fk.refTable);
    const list = incoming.get(k);
    if (list) list.push(fk); else incoming.set(k, [fk]);
  }
  const paths: CascadePath[] = [];
  const walk = (at: TableRef, chain: DbForeignKey[], onChain: Set<string>) => {
    for (const fk of incoming.get(tableKey(at.schema, at.table)) ?? []) {
      if (paths.length >= MAX_CASCADE_PATHS) return;
      const child = tableKey(fk.schema, fk.table);
      if (onChain.has(child)) continue;
      const next = [...chain, fk];
      paths.push({ fks: next });
      if (next.length < MAX_CASCADE_DEPTH) walk({ schema: fk.schema, table: fk.table }, next, new Set(onChain).add(child));
    }
  };
  walk(table, [], new Set([tableKey(table.schema, table.table)]));
  return paths;
}

/** Group paths by the table they delete from, deepest first: a child's rows must go before its parent's. */
export function groupCascadePaths(paths: CascadePath[]): { ref: TableRef; paths: CascadePath[] }[] {
  const groups = new Map<string, { ref: TableRef; paths: CascadePath[] }>();
  for (const p of paths) {
    const last = p.fks[p.fks.length - 1]!;
    const k = tableKey(last.schema, last.table);
    const g = groups.get(k);
    if (g) g.paths.push(p); else groups.set(k, { ref: { schema: last.schema, table: last.table }, paths: [p] });
  }
  const depth = (g: { paths: CascadePath[] }) => Math.max(...g.paths.map((p) => p.fks.length));
  return [...groups.values()].sort((a, b) =>
    depth(b) - depth(a)
    || (a.ref.schema ?? "").localeCompare(b.ref.schema ?? "")
    || a.ref.table.localeCompare(b.ref.table));
}

export interface BuiltChangeset {
  /** In execution order. */
  statements: ChangesetStatement[];
  /** Tables that point at deleted rows, with what ticking each would add. Empty without deletes. */
  references: ChangesetReference[];
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Build every statement of a changeset. `foreignKeys` is the whole database's
 * list and is only needed when rows are deleted; `cascade` picks which of the
 * referencing tables get their rows deleted first.
 */
export function buildChangeset(
  d: SqlDialect,
  table: ChangesetTable,
  cs: Pick<ValidChangeset, "inserts" | "updates" | "deletes" | "cascade">,
  foreignKeys: DbForeignKey[] = [],
): BuiltChangeset {
  const b = new ChangesetBuilder(d, table);
  const deletes = uniqueDeletes(cs.deletes);
  const deletedKeys = deletes.map((x) => x.key);

  const groups = deletes.length > 0 ? groupCascadePaths(findCascadePaths(foreignKeys, { schema: table.schema, table: table.name })) : [];
  const cascadeStatements = (g: { paths: CascadePath[] }) =>
    g.paths.flatMap((p) => chunks(deletedKeys, CASCADE_KEYS_PER_STATEMENT).map((keys) => b.cascade(p.fks, keys)));

  const references: ChangesetReference[] = groups.map((g) => ({
    ...g.ref,
    paths: g.paths.map((p) => [g.ref.table, ...p.fks.slice(0, -1).reverse().map((fk) => fk.table), table.name]),
    cascadesInDb: g.paths.every((p) => p.fks.every((fk) => fk.onDelete === "CASCADE")),
    script: cascadeStatements(g).map((s) => `${s.displaySql};`).join("\n"),
  }));

  const ticked = new Set(cs.cascade.map((r) => tableKey(r.schema, r.table)));
  const unknown = cs.cascade.find((r) => !groups.some((g) => tableKey(g.ref.schema, g.ref.table) === tableKey(r.schema, r.table)));
  if (unknown) fail(`"${unknown.table}" does not point at the rows being deleted`);

  const statements = [
    ...groups.filter((g) => ticked.has(tableKey(g.ref.schema, g.ref.table))).flatMap(cascadeStatements),
    ...cs.inserts.map((row) => b.insert(row)),
    ...mergeUpdates(cs.updates).map((u) => b.update(u)),
    ...deletes.map((x) => b.delete(x.key)),
  ];
  return { statements, references };
}

/** The display script: one statement per line, as the Save dialog shows it. */
export function changesetScript(statements: ChangesetStatement[]): string {
  return statements.map((s) => `${s.displaySql};`).join("\n");
}

/**
 * A statement of an applied changeset failed, or hit a number of rows other
 * than one. Nothing was written: the transaction was rolled back.
 */
export class ChangesetStatementError extends Error {
  constructor(
    /** Position in the statement list; null when the COMMIT itself failed (a deferred constraint). */
    readonly index: number | null,
    readonly statement: ChangesetStatement | null,
    /** What the database said, when it refused the statement. */
    readonly dbError: unknown,
    /** Rows an `expectOne` statement actually hit. */
    readonly affected?: number,
  ) {
    super(affected !== undefined
      ? affected === 0
        ? "The row was changed or deleted by someone else since it was loaded"
        : `The key matched ${affected} rows instead of one`
      : (dbError as Error | null)?.message ?? String(dbError));
  }
}

/** Throw when an `expectOne` statement did not hit exactly one row. */
export function checkAffected(statements: ChangesetStatement[], index: number, affected: number): void {
  const s = statements[index]!;
  if (s.expectOne && affected !== 1) throw new ChangesetStatementError(index, s, null, affected);
}

/**
 * The message a person reads after a failed save, and the details the Save
 * dialog uses to point at the statement. Says which statement it was, in the
 * dialog's own numbering, because "violates not-null constraint" alone does
 * not say which of forty edits caused it.
 */
export function describeFailure(e: ChangesetStatementError, statements: ChangesetStatement[]): { message: string; data: ChangesetFailure } {
  const total = statements.length;
  const data: ChangesetFailure = { statementCount: total };
  if (e.index === null) return { message: `The commit failed: ${e.message}. Nothing was saved.`, data };
  data.statementIndex = e.index;
  data.sql = e.statement?.displaySql;
  if (e.affected !== undefined) data.affected = e.affected;
  const hint = e.affected === 0 ? " Reload to see its current values." : "";
  return { message: `Statement ${e.index + 1} of ${total} failed: ${e.message}. Nothing was saved.${hint}\n${data.sql}`, data };
}
