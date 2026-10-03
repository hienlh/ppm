/**
 * Read a SQLite database's structure from its pragmas and `sqlite_schema`.
 * SQLite keeps no catalog of CHECK constraints or index expressions, so those
 * two are read back out of the `CREATE` statement it stores.
 */
import type { Database } from "bun:sqlite";
import type {
  DbCheckConstraint, DbColumnRef, DbForeignKey, DbIndex, DbIndexKey, DbObject, DbObjectList, DbTableStructure, FkAction,
} from "../../shared/db-structure.ts";

/** Names that reach the implicit rowid, in the order SQLite documents them. */
export const ROWID_ALIASES = ["rowid", "_rowid_", "oid"] as const;

const FK_ACTIONS = new Set<FkAction>(["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"]);

export interface Token { kind: "word" | "quoted" | "string" | "punct"; text: string; start: number; end: number }

/**
 * Split DDL into tokens, skipping whitespace and comments. Only as much of
 * SQLite's grammar as finding parentheses and keywords needs: a `(` inside a
 * string or a quoted name must not count as one.
 */
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close === -1 ? sql.length : close + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const closer = c === "[" ? "]" : c;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === closer) {
          if (closer !== "]" && sql[j + 1] === closer) { j += 2; continue; }
          break;
        }
        j++;
      }
      tokens.push({ kind: c === "'" ? "string" : "quoted", text: sql.slice(i, j + 1), start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    const word = /^[A-Za-z0-9_$\u0080-￿]+/.exec(sql.slice(i));
    if (word) {
      tokens.push({ kind: "word", text: word[0], start: i, end: i + word[0].length });
      i += word[0].length;
      continue;
    }
    tokens.push({ kind: "punct", text: c, start: i, end: i + 1 });
    i++;
  }
  return tokens;
}

/** Index of the `)` that closes the `(` at `open`, or -1. */
export function closingParen(tokens: Token[], open: number): number {
  let depth = 0;
  for (let k = open; k < tokens.length; k++) {
    if (tokens[k]!.text === "(") depth++;
    else if (tokens[k]!.text === ")" && --depth === 0) return k;
  }
  return -1;
}

function isWord(t: Token | undefined, word: string): boolean {
  return !!t && t.kind === "word" && t.text.toUpperCase() === word;
}

export function unquote(text: string): string {
  const q = text[0];
  if (q === '"' || q === "`") return text.slice(1, -1).split(q + q).join(q);
  if (q === "[") return text.slice(1, -1);
  return text;
}

/**
 * Every `CHECK (…)` in a `CREATE TABLE`, column constraints and table constraints alike; a column
 * constraint says which column declares it.
 */
export function extractChecks(createSql: string): DbCheckConstraint[] {
  const tokens = tokenize(createSql);
  const columns = columnEntries(tokens);
  const checks: DbCheckConstraint[] = [];
  for (let k = 0; k < tokens.length; k++) {
    if (!isWord(tokens[k], "CHECK") || tokens[k + 1]?.text !== "(") continue;
    const close = closingParen(tokens, k + 1);
    if (close === -1) break;
    const named = isWord(tokens[k - 2], "CONSTRAINT") ? tokens[k - 1] : undefined;
    const entry = columns.find(([start, end]) => start < k && k < end);
    const check: DbCheckConstraint = {
      name: named ? unquote(named.text) : null,
      expression: createSql.slice(tokens[k + 1]!.end, tokens[close]!.start).trim(),
    };
    if (entry) check.column = unquote(tokens[entry[0]]!.text);
    checks.push(check);
    k = close;
  }
  return checks;
}

/** Words that open a table constraint: a table body entry starting with one is not a column. */
const TABLE_CONSTRAINT_WORDS = new Set(["CONSTRAINT", "PRIMARY", "UNIQUE", "CHECK", "FOREIGN"]);

/**
 * A `CREATE TABLE` body's entries — columns and table constraints — as token ranges `[start, end)`,
 * split at its top-level commas; empty when the text has no body.
 */
export function tableBodyEntries(tokens: Token[]): [number, number][] {
  const open = tokens.findIndex((t) => t.text === "(");
  const close = open === -1 ? -1 : closingParen(tokens, open);
  if (close === -1) return [];
  const entries: [number, number][] = [];
  let from = open + 1;
  let depth = 0;
  for (let k = open + 1; k < close; k++) {
    const t = tokens[k]!.text;
    if (t === "(") depth++;
    else if (t === ")") depth--;
    else if (t === "," && depth === 0) {
      entries.push([from, k]);
      from = k + 1;
    }
  }
  entries.push([from, close]);
  return entries;
}

/** The column entries of a table body: the ones that do not open with a table constraint's word. */
function columnEntries(tokens: Token[]): [number, number][] {
  return tableBodyEntries(tokens).filter(([start]) => {
    const name = tokens[start];
    return !!name && name.kind !== "punct" && !(name.kind === "word" && TABLE_CONSTRAINT_WORDS.has(name.text.toUpperCase()));
  });
}

/**
 * The expression of every generated column in a `CREATE TABLE`, by lowercased column name. SQLite
 * says only that a column is generated (`pragma_table_xinfo.hidden` 2 or 3); what it is computed
 * from is only in the text, as `name type GENERATED ALWAYS AS (expr)` or the short `name AS (expr)`.
 */
export function extractGeneratedColumns(createSql: string): Map<string, string> {
  const found = new Map<string, string>();
  const tokens = tokenize(createSql);
  for (const [start, end] of columnEntries(tokens)) {
    const name = tokens[start]!;
    // `AS (` at the entry's own level: one inside a DEFAULT or CHECK is a CAST.
    let level = 0;
    for (let k = start + 1; k < end; k++) {
      const t = tokens[k]!;
      if (t.text === "(") level++;
      else if (t.text === ")") level--;
      else if (level === 0 && isWord(t, "AS") && tokens[k + 1]?.text === "(") {
        const exprEnd = closingParen(tokens, k + 1);
        if (exprEnd !== -1) found.set(unquote(name.text).toLowerCase(), createSql.slice(tokens[k + 1]!.end, tokens[exprEnd]!.start).trim());
        break;
      }
    }
  }
  return found;
}

export interface SqliteColumnText {
  /** What follows the column's `COLLATE`, as written. */
  collation: string | null;
  /** The column is declared `… PRIMARY KEY AUTOINCREMENT`. */
  autoincrement: boolean;
}

/**
 * What only the text of a `CREATE TABLE` says about each column, by lowercased name: its
 * collation, which no pragma reports, and whether its key is `AUTOINCREMENT` — `pragma_table_info`
 * says only that it is the rowid, and the two reuse rowids differently.
 */
export function extractColumnText(createSql: string): Map<string, SqliteColumnText> {
  const found = new Map<string, SqliteColumnText>();
  const tokens = tokenize(createSql);
  for (const [start, end] of columnEntries(tokens)) {
    const info: SqliteColumnText = { collation: null, autoincrement: false };
    let level = 0;
    for (let k = start + 1; k < end; k++) {
      const t = tokens[k]!;
      if (t.text === "(") level++;
      else if (t.text === ")") level--;
      else if (level !== 0) continue;
      else if (isWord(t, "COLLATE") && k + 1 < end) info.collation = tokens[k + 1]!.text;
      else if (isWord(t, "AUTOINCREMENT")) info.autoincrement = true;
    }
    found.set(unquote(tokens[start]!.text).toLowerCase(), info);
  }
  return found;
}

/** The key list and `WHERE` of a `CREATE INDEX`: expression entries are only in the text. */
export function parseCreateIndex(createSql: string): { columns: string[]; where: string | null } | null {
  const tokens = tokenize(createSql);
  const on = tokens.findIndex((t) => isWord(t, "ON"));
  const open = tokens.findIndex((t, k) => k > on && t.text === "(");
  if (on === -1 || open === -1) return null;
  const close = closingParen(tokens, open);
  if (close === -1) return null;
  const columns: string[] = [];
  let from = tokens[open]!.end;
  let depth = 0;
  for (let k = open + 1; k < close; k++) {
    const t = tokens[k]!;
    if (t.text === "(") depth++;
    else if (t.text === ")") depth--;
    else if (t.text === "," && depth === 0) {
      columns.push(createSql.slice(from, t.start).trim());
      from = t.end;
    }
  }
  columns.push(createSql.slice(from, tokens[close]!.start).trim());
  const where = isWord(tokens[close + 1], "WHERE") ? createSql.slice(tokens[close + 1]!.end).trim().replace(/;\s*$/, "") : null;
  return { columns, where };
}

/** An expression key part as written in `CREATE INDEX`, less the `ASC`/`DESC` the pragma already reports. */
function stripDirection(part: string | undefined): string | null {
  if (part === undefined) return null;
  return part.replace(/\s+(ASC|DESC)\s*$/i, "").trim();
}

function fkAction(value: unknown): FkAction {
  const v = String(value ?? "").toUpperCase() as FkAction;
  return FK_ACTIONS.has(v) ? v : "NO ACTION";
}

interface FkRow { table: string; id: number; seq: number; from: string; to: string | null; parent: string; on_update: string; on_delete: string }

/**
 * Group `foreign_key_list` rows into keys. A key written `REFERENCES parent`
 * with no column list names the parent's primary key, and the pragma reports
 * that as a NULL `to`, so those are resolved against the parent.
 */
function groupForeignKeys(db: Database, rows: FkRow[]): DbForeignKey[] {
  const byKey = new Map<string, FkRow[]>();
  for (const r of rows) {
    const k = `${r.table}\u0000${r.id}`;
    const list = byKey.get(k);
    if (list) list.push(r); else byKey.set(k, [r]);
  }
  // A key may name its parent in any case (`REFERENCES Users`); SQLite matches
  // names without case, so the parent is spelled the way the table itself is.
  const tables = new Map((db.query(`SELECT name FROM sqlite_schema WHERE type = 'table'`).all() as { name: string }[])
    .map((t) => [t.name.toLowerCase(), t.name]));
  const parentPk = new Map<string, string[]>();
  const pkOf = (parent: string) => {
    let pk = parentPk.get(parent.toLowerCase());
    if (!pk) {
      const cols = db.query(`SELECT name, pk FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk`).all(parent) as { name: string }[];
      pk = cols.map((c) => c.name);
      parentPk.set(parent.toLowerCase(), pk);
    }
    return pk;
  };
  return [...byKey.values()].map((list) => {
    list.sort((a, b) => a.seq - b.seq);
    const first = list[0]!;
    const implicit = list.some((r) => r.to == null);
    const refColumns = implicit ? pkOf(first.parent) : list.map((r) => r.to!);
    return {
      name: null,
      schema: null,
      table: first.table,
      columns: list.map((r) => r.from),
      refSchema: null,
      refTable: tables.get(first.parent.toLowerCase()) ?? first.parent,
      refColumns,
      onDelete: fkAction(first.on_delete),
      onUpdate: fkAction(first.on_update),
    };
  });
}

const FK_ROWS = `
  SELECT m.name AS "table", f.id, f.seq, f."from", f."to", f."table" AS parent, f.on_update, f.on_delete
  FROM sqlite_schema m, pragma_foreign_key_list(m.name) f
  WHERE m.type = 'table'`;

export function sqliteListObjects(db: Database): DbObjectList {
  const rows = db.query(`
    SELECT type, name, tbl_name FROM sqlite_schema
    WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
    ORDER BY name`).all() as { type: string; name: string; tbl_name: string }[];
  const objects: DbObject[] = rows.map((r) => (r.type === "trigger"
    ? { schema: null, name: r.name, kind: "trigger", table: r.tbl_name }
    : { schema: null, name: r.name, kind: r.type as "table" | "view" }));
  return { schemas: [], objects };
}

export function sqliteListColumns(db: Database): DbColumnRef[] {
  const rows = db.query(`
    SELECT m.name AS tbl, p.name AS name, p.type AS type
    FROM sqlite_schema m JOIN pragma_table_xinfo(m.name) p
    WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND p.hidden <> 1
    ORDER BY m.name, p.cid`).all() as { tbl: string; name: string; type: string | null }[];
  return rows.map((r) => ({ schema: null, table: r.tbl, name: r.name, type: r.type ?? "" }));
}

export function sqliteListForeignKeys(db: Database): DbForeignKey[] {
  return groupForeignKeys(db, db.query(`${FK_ROWS} ORDER BY m.name, f.id, f.seq`).all() as FkRow[]);
}

/**
 * The column that is a table's rowid itself (`INTEGER PRIMARY KEY`), or null. SQLite gives every
 * other primary key an index of its own — one of two columns, an `INT` one, a WITHOUT ROWID table's,
 * even an `INTEGER PRIMARY KEY DESC`, a quirk it keeps for compatibility — so a key with none is it.
 */
export function sqliteRowidAlias(db: Database, table: string): string | null {
  const key = db.query("SELECT name FROM pragma_table_info(?) WHERE pk > 0").get(table) as { name: string } | null;
  if (!key || db.query("SELECT 1 FROM pragma_index_list(?) WHERE origin = 'pk'").get(table)) return null;
  return key.name;
}

export function sqliteGetStructure(db: Database, table: string): DbTableStructure | null {
  const obj = db.query(`SELECT type, name, sql FROM sqlite_schema WHERE type IN ('table', 'view') AND name = ? COLLATE NOCASE`)
    .get(table) as { type: string; name: string; sql: string | null } | null;
  if (!obj) return null;
  const name = obj.name;

  const cols = db.query(`SELECT name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid`)
    .all(name) as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number; hidden: number }[];
  // hidden = 1 is a virtual table's hidden column; 2 and 3 are generated columns.
  const visible = cols.filter((c) => c.hidden !== 1);
  const info = db.query(`SELECT type, wr, strict FROM pragma_table_list WHERE schema = 'main' AND name = ?`)
    .get(name) as { type: string; wr: number; strict: number } | null;
  const withoutRowid = info?.wr === 1;
  const isView = obj.type === "view";

  const pkCols = visible.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);

  const indexList = isView ? [] : db.query(`SELECT name, "unique", origin, partial FROM pragma_index_list(?)`)
    .all(name) as { name: string; unique: number; origin: string; partial: number }[];
  const indexes: DbIndex[] = indexList.map((ix) => {
    const keys = db.query(`SELECT cid, name, "desc" FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno`)
      .all(ix.name) as { cid: number; name: string | null; desc: number }[];
    const ddl = db.query(`SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?`).get(ix.name) as { sql: string | null } | null;
    const parsed = ddl?.sql ? parseCreateIndex(ddl.sql) : null;
    // An expression entry has no name in the pragma (cid -2); only the CREATE INDEX text says what it is.
    const columns = keys.map((k, n) => k.name ?? (k.cid === -2 ? stripDirection(parsed?.columns[n]) : null) ?? (k.cid === -1 ? "rowid" : "<expression>"));
    return {
      name: ix.name,
      columns,
      keys: keys.map((k, n): DbIndexKey => ({
        column: k.name,
        expression: k.name === null ? columns[n]! : null,
        descending: k.desc === 1,
      })),
      unique: ix.unique === 1,
      primary: ix.origin === "pk",
      where: parsed?.where ?? null,
      method: null,
    };
  });

  const rowidAlias = isView ? null : sqliteRowidAlias(db, name);

  const shadowed = new Set(visible.map((c) => c.name.toLowerCase()));
  const rowid = !isView && !withoutRowid && pkCols.length === 0
    ? ROWID_ALIASES.find((alias) => !shadowed.has(alias)) ?? null
    : null;

  const expressions = obj.sql && !isView && visible.some((c) => c.hidden === 2 || c.hidden === 3)
    ? extractGeneratedColumns(obj.sql)
    : null;
  const columnText = obj.sql && !isView ? extractColumnText(obj.sql) : null;

  const outgoing = isView ? [] : groupForeignKeys(db, db.query(`${FK_ROWS} AND m.name = ? ORDER BY f.id, f.seq`).all(name) as FkRow[]);
  const incoming = isView ? [] : groupForeignKeys(db, db.query(`${FK_ROWS} AND f."table" = ? COLLATE NOCASE ORDER BY m.name, f.id, f.seq`).all(name) as FkRow[]);

  return {
    schema: null,
    name,
    kind: isView ? "view" : "table",
    columns: visible.map((c) => ({
      name: c.name,
      type: c.type ?? "",
      nullable: c.notnull === 0 && c.name !== rowidAlias,
      defaultValue: c.dflt_value,
      comment: null,
      autoIncrement: c.name === rowidAlias,
      generated: c.hidden === 2 || c.hidden === 3,
      computedExpression: c.hidden === 2 || c.hidden === 3 ? expressions?.get(c.name.toLowerCase()) ?? null : null,
      collation: columnText?.get(c.name.toLowerCase())?.collation ?? null,
      // hidden 3 is a STORED generated column, 2 a VIRTUAL one.
      ...(c.hidden === 2 || c.hidden === 3 ? { computedStored: c.hidden === 3 } : {}),
      ...(c.name === rowidAlias && columnText?.get(c.name.toLowerCase())?.autoincrement ? { sqliteAutoincrement: true } : {}),
    })),
    primaryKey: pkCols.length > 0 ? { name: null, columns: pkCols } : null,
    foreignKeys: outgoing,
    references: incoming,
    indexes,
    uniques: indexes.filter((ix) => indexList.find((l) => l.name === ix.name)?.origin === "u").map((ix) => ({ name: null, columns: ix.columns })),
    checks: obj.sql && !isView ? extractChecks(obj.sql) : [],
    comment: null,
    ...(isView ? {} : { withoutRowid, strict: info?.strict === 1 }),
    rowKey: pkCols.length > 0 ? pkCols : rowid ? [rowid] : [],
    rowKeyIsRowid: pkCols.length === 0 && rowid !== null,
  };
}
