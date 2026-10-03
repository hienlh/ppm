/**
 * The table editor's model (DBGate's TableEditor): a table as columns, a primary key, indexes,
 * unique constraints and foreign keys, each carrying a pairing id that survives any edit. The
 * Structure tab keeps two of them — `base`, the table as the catalog described it when editing
 * began, and `current`, what the user has made of it — and Save sends both. Pairing by id rather
 * than by name is what tells a renamed column from a dropped one plus a new one: a rename keeps
 * the column's data, drop-and-add throws it away.
 *
 * Keys and indexes name their columns by id too, so renaming a column changes nothing else in
 * the model: the constraint on it is the same constraint. A foreign key's referenced columns are
 * the other table's, and stay names.
 *
 * Pure and shared: the browser edits it, the server checks it against the live catalog and turns
 * the difference into DDL.
 */
import type { DbCheckConstraint, DbIndex, DbTableStructure, FkAction } from "./db-structure";
import type { DialectName } from "./db-types";

export interface TableModelColumn {
  id: string;
  name: string;
  /** The declared type; for MySQL without `unsigned` and `zerofill`, which are flags of their own. */
  type: string;
  notNull: boolean;
  autoIncrement: boolean;
  /** An SQL expression — `'Hello World'` for a string, `0`, `now()` — or null for none. */
  defaultValue: string | null;
  /** A generated column's expression; null for an ordinary column. */
  computedExpression: string | null;
  comment: string | null;
  /** MySQL only. */
  unsigned: boolean;
  zerofill: boolean;
  /** Carried from the catalog and never edited here: what redefining the column must say again (see `DbStructureColumn`). */
  collation: string | null;
  computedStored: boolean;
  onUpdate: string | null;
  identity: "always" | "default" | null;
  sqliteAutoincrement: boolean;
}

export interface TableModelPrimaryKey {
  id: string;
  /** Null where the engine gives a primary key no name of its own (MySQL, SQLite), or until Save names it. */
  name: string | null;
  /** Column ids, in key order. */
  columns: string[];
}

export interface TableModelIndexColumn {
  /** The column's id; null for an expression part, which the editor shows but cannot change. */
  columnId: string | null;
  expression: string | null;
  descending: boolean;
  nulls?: "first" | "last";
  length?: number;
  opclass?: string;
}

export interface TableModelIndex {
  id: string;
  /** Empty until Save names it `IX_<table>_<columns>`. */
  name: string;
  columns: TableModelIndexColumn[];
  unique: boolean;
  /** Postgres' access method or MySQL's index type when it is not the default B-tree: `gin`, `hash`, `fulltext`, `spatial`. */
  method: string | null;
  /** A partial index's condition (Postgres, SQLite). */
  where: string | null;
}

export interface TableModelUnique {
  id: string;
  name: string | null;
  columns: string[];
}

export interface TableModelForeignKey {
  id: string;
  name: string | null;
  /** This table's columns, by id. */
  columns: string[];
  refSchema: string | null;
  /** Empty while none is chosen. */
  refTable: string;
  /** The referenced table's columns, by name, pairing with `columns`; empty while one is not chosen. */
  refColumns: string[];
  /** Null says nothing, which the engine takes as NO ACTION. */
  onUpdate: FkAction | null;
  onDelete: FkAction | null;
}

export interface TableModel {
  schema: string | null;
  name: string;
  columns: TableModelColumn[];
  primaryKey: TableModelPrimaryKey | null;
  indexes: TableModelIndex[];
  uniques: TableModelUnique[];
  foreignKeys: TableModelForeignKey[];
  /** Kept as they are: the editor has no section for CHECK constraints. */
  checks: DbCheckConstraint[];
  comment: string | null;
  /** MySQL. */
  engine: string | null;
  /** SQLite. */
  withoutRowid: boolean;
  strict: boolean;
}

export type TableModelSection = "columns" | "primaryKey" | "indexes" | "uniques" | "foreignKeys";

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((c, i) => c === b[i]);

/**
 * The indexes with no section of their own elsewhere: not the primary key's, and not one a unique
 * constraint owns. A constraint is matched by name, or — SQLite names neither — as a unique index
 * on the same columns.
 */
export function ownIndexes(s: Pick<DbTableStructure, "indexes" | "uniques">): DbIndex[] {
  return s.indexes.filter((ix) => !ix.primary && !s.uniques.some((u) => (u.name !== null ? u.name === ix.name : ix.unique && sameList(u.columns, ix.columns))));
}

/** A column's id as the catalog names it: the same table read twice pairs up. */
export const baseColumnId = (name: string) => `c:${name}`;

/** MySQL prints the two flags inside the type: `int(10) unsigned zerofill`. */
export function splitMysqlType(type: string): { type: string; unsigned: boolean; zerofill: boolean } {
  let rest = type.trim();
  let unsigned = false;
  let zerofill = false;
  for (;;) {
    const m = /\s+(unsigned|zerofill)$/i.exec(rest);
    if (!m) break;
    if (m[1]!.toLowerCase() === "unsigned") unsigned = true;
    else zerofill = true;
    rest = rest.slice(0, m.index);
  }
  return { type: rest, unsigned, zerofill };
}

/** The type as the engine takes it back: MySQL's flags written into it again. */
export function declaredType(c: Pick<TableModelColumn, "type" | "unsigned" | "zerofill">, dialect: DialectName): string {
  if (dialect !== "mysql") return c.type;
  return [c.type, c.unsigned ? "unsigned" : "", c.zerofill ? "zerofill" : ""].filter(Boolean).join(" ");
}

/** The model of a table as the catalog describes it, with ids that pair it with itself read again. */
export function modelFromStructure(s: DbTableStructure, dialect: DialectName): TableModel {
  const idOf = new Map(s.columns.map((c) => [c.name, baseColumnId(c.name)]));
  const colId = (name: string) => idOf.get(name) ?? baseColumnId(name);
  return {
    schema: s.schema,
    name: s.name,
    columns: s.columns.map((c) => {
      const split = dialect === "mysql" ? splitMysqlType(c.type) : { type: c.type, unsigned: false, zerofill: false };
      return {
        id: colId(c.name),
        name: c.name,
        type: split.type,
        notNull: !c.nullable,
        autoIncrement: c.autoIncrement,
        defaultValue: c.defaultValue,
        computedExpression: c.generated ? c.computedExpression : null,
        comment: c.comment,
        unsigned: split.unsigned,
        zerofill: split.zerofill,
        collation: c.collation ?? null,
        computedStored: c.computedStored ?? false,
        onUpdate: c.onUpdate ?? null,
        identity: c.identity ?? null,
        sqliteAutoincrement: c.sqliteAutoincrement ?? false,
      };
    }),
    primaryKey: s.primaryKey ? { id: "pk", name: s.primaryKey.name, columns: s.primaryKey.columns.map(colId) } : null,
    indexes: ownIndexes(s).map((ix) => ({
      id: `ix:${ix.name}`,
      name: ix.name,
      columns: ix.keys.map((k) => {
        const known = k.column !== null && idOf.has(k.column);
        const part: TableModelIndexColumn = {
          columnId: known ? colId(k.column!) : null,
          // A key on something that is not one of the columns (SQLite's rowid) can only be kept as written.
          expression: known ? null : k.expression ?? k.column,
          descending: k.descending,
        };
        if (k.nulls) part.nulls = k.nulls;
        if (k.length !== undefined) part.length = k.length;
        if (k.opclass) part.opclass = k.opclass;
        return part;
      }),
      unique: ix.unique,
      method: ix.method && ix.method !== "btree" ? ix.method : null,
      where: ix.where,
    })),
    uniques: s.uniques.map((u, i) => ({ id: u.name !== null ? `uq:${u.name}` : `uq#${i}`, name: u.name, columns: u.columns.map(colId) })),
    foreignKeys: s.foreignKeys.map((fk, i) => ({
      id: fk.name !== null ? `fk:${fk.name}` : `fk#${i}`,
      name: fk.name,
      columns: fk.columns.map(colId),
      refSchema: fk.refSchema,
      refTable: fk.refTable,
      refColumns: [...fk.refColumns],
      onUpdate: fk.onUpdate,
      onDelete: fk.onDelete,
    })),
    checks: s.checks.map((c) => ({ ...c })),
    comment: s.comment,
    engine: s.engine ?? null,
    withoutRowid: s.withoutRowid ?? false,
    strict: s.strict ?? false,
  };
}

/** An id no item of the model has yet. */
export function newItemId(model: TableModel, prefix = "n"): string {
  const used = new Set<string>([
    ...model.columns.map((c) => c.id), ...model.indexes.map((x) => x.id), ...model.uniques.map((x) => x.id), ...model.foreignKeys.map((x) => x.id),
    ...(model.primaryKey ? [model.primaryKey.id] : []),
  ]);
  for (let n = used.size + 1; ; n++) {
    const id = `${prefix}:${n}`;
    if (!used.has(id)) return id;
  }
}

export function blankColumn(id: string, name = ""): TableModelColumn {
  return {
    id, name, type: "int", notNull: false, autoIncrement: false, defaultValue: null, computedExpression: null, comment: null,
    unsigned: false, zerofill: false, collation: null, computedStored: false, onUpdate: null, identity: null, sqliteAutoincrement: false,
  };
}

/**
 * A table no one has saved yet, as DBGate starts one: `new_table` with an `id int NOT NULL`
 * autoincrement primary key, in the schema being looked at.
 */
export function newTableModel(schema: string | null): TableModel {
  const id = { ...blankColumn("n:1", "id"), notNull: true, autoIncrement: true };
  return {
    schema, name: "new_table", columns: [id], primaryKey: { id: "n:2", name: null, columns: [id.id] },
    indexes: [], uniques: [], foreignKeys: [], checks: [], comment: null, engine: null, withoutRowid: false, strict: false,
  };
}

export function columnById(model: TableModel, id: string): TableModelColumn | undefined {
  return model.columns.find((c) => c.id === id);
}

export function columnName(model: TableModel, id: string): string {
  return columnById(model, id)?.name ?? "";
}

export function isPrimaryKeyColumn(model: TableModel, columnId: string): boolean {
  return model.primaryKey?.columns.includes(columnId) ?? false;
}

/** The foreign key points back at its own table: its referenced columns are then this model's own. */
export function isSelfReference(model: Pick<TableModel, "schema" | "name">, fk: Pick<TableModelForeignKey, "refSchema" | "refTable">): boolean {
  return fk.refTable === model.name && (fk.refSchema ?? null) === (model.schema ?? null);
}

/**
 * Put a column in or take it out of the primary key, as the column dialog's "Is Primary Key"
 * does: a key is created for the first column and dropped with its last.
 */
export function setPrimaryKeyMember(model: TableModel, columnId: string, member: boolean): TableModel {
  const pk = model.primaryKey;
  if (member) {
    if (pk?.columns.includes(columnId)) return model;
    return { ...model, primaryKey: pk ? { ...pk, columns: [...pk.columns, columnId] } : { id: newItemId(model), name: null, columns: [columnId] } };
  }
  if (!pk?.columns.includes(columnId)) return model;
  const columns = pk.columns.filter((c) => c !== columnId);
  return { ...model, primaryKey: columns.length > 0 ? { ...pk, columns } : null };
}

/** Add a column, or replace the one with its id; `primaryKey` says whether it is in the key. */
export function upsertColumn(model: TableModel, column: TableModelColumn, primaryKey?: boolean): TableModel {
  const before = columnById(model, column.id);
  let next: TableModel = {
    ...model,
    columns: before ? model.columns.map((c) => (c.id === column.id ? column : c)) : [...model.columns, column],
  };
  // A foreign key on its own table names this column by name, so a rename has to reach it.
  if (before && before.name !== column.name) {
    next = {
      ...next,
      foreignKeys: next.foreignKeys.map((fk) => (isSelfReference(model, fk)
        ? { ...fk, refColumns: fk.refColumns.map((r) => (r === before.name ? column.name : r)) }
        : fk)),
    };
  }
  return primaryKey === undefined ? next : setPrimaryKeyMember(next, column.id, primaryKey);
}

/**
 * Remove columns and every reference to them: out of the primary key, the indexes and the unique
 * constraints — each dropped once it names no column — and the foreign keys, which lose the pair
 * the column was in. DBGate took a column out of the primary key only when one column was removed.
 */
export function removeColumns(model: TableModel, ids: readonly string[]): TableModel {
  const gone = new Set(ids);
  const removedNames = new Set(model.columns.filter((c) => gone.has(c.id)).map((c) => c.name));
  const pkColumns = model.primaryKey?.columns.filter((c) => !gone.has(c)) ?? [];
  return {
    ...model,
    columns: model.columns.filter((c) => !gone.has(c.id)),
    primaryKey: model.primaryKey && pkColumns.length > 0 ? { ...model.primaryKey, columns: pkColumns } : null,
    indexes: model.indexes
      .map((ix) => ({ ...ix, columns: ix.columns.filter((c) => c.columnId === null || !gone.has(c.columnId)) }))
      .filter((ix) => ix.columns.length > 0),
    uniques: model.uniques.map((u) => ({ ...u, columns: u.columns.filter((c) => !gone.has(c)) })).filter((u) => u.columns.length > 0),
    foreignKeys: model.foreignKeys
      .map((fk) => {
        const self = isSelfReference(model, fk);
        const keep = fk.columns.map((c, i) => !gone.has(c) && !(self && removedNames.has(fk.refColumns[i] ?? "")));
        return { ...fk, columns: fk.columns.filter((_, i) => keep[i]), refColumns: fk.refColumns.filter((_, i) => keep[i]) };
      })
      .filter((fk) => fk.columns.length > 0),
  };
}

type Keyed = { id: string };

/** Add an item to a section, or replace the one with its id. */
export function upsertItem<K extends "indexes" | "uniques" | "foreignKeys">(model: TableModel, section: K, item: TableModel[K][number]): TableModel {
  const list = model[section] as Keyed[];
  const exists = list.some((x) => x.id === item.id);
  return { ...model, [section]: exists ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item] };
}

export function removeItem(model: TableModel, section: "primaryKey" | "indexes" | "uniques" | "foreignKeys", id: string): TableModel {
  if (section === "primaryKey") return model.primaryKey?.id === id ? { ...model, primaryKey: null } : model;
  return { ...model, [section]: (model[section] as Keyed[]).filter((x) => x.id !== id) };
}

/**
 * The model in a form two equal tables share whatever produced them: every field present, in one
 * order. A model that went through a tab's metadata (JSON, which drops `undefined`) compares equal
 * to the one built fresh from the same catalog.
 */
export function canonicalTableModel(m: TableModel): unknown {
  return {
    schema: m.schema ?? null,
    name: m.name,
    columns: m.columns.map((c) => [
      c.id, c.name, c.type, !!c.notNull, !!c.autoIncrement, c.defaultValue ?? null, c.computedExpression ?? null, c.comment ?? null,
      !!c.unsigned, !!c.zerofill, c.collation ?? null, !!c.computedStored, c.onUpdate ?? null, c.identity ?? null, !!c.sqliteAutoincrement,
    ]),
    primaryKey: m.primaryKey ? [m.primaryKey.id, m.primaryKey.name ?? null, [...m.primaryKey.columns]] : null,
    indexes: m.indexes.map((ix) => [
      ix.id, ix.name, ix.columns.map((k) => [k.columnId ?? null, k.expression ?? null, !!k.descending, k.nulls ?? null, k.length ?? null, k.opclass ?? null]),
      !!ix.unique, ix.method ?? null, ix.where ?? null,
    ]),
    uniques: m.uniques.map((u) => [u.id, u.name ?? null, [...u.columns]]),
    foreignKeys: m.foreignKeys.map((fk) => [fk.id, fk.name ?? null, [...fk.columns], fk.refSchema ?? null, fk.refTable, [...fk.refColumns], fk.onUpdate ?? null, fk.onDelete ?? null]),
    checks: m.checks.map((c) => [c.name ?? null, c.expression]),
    comment: m.comment ?? null,
    engine: m.engine ?? null,
    withoutRowid: !!m.withoutRowid,
    strict: !!m.strict,
  };
}

export function sameTableModel(a: TableModel, b: TableModel): boolean {
  return JSON.stringify(canonicalTableModel(a)) === JSON.stringify(canonicalTableModel(b));
}

// ---------------------------------------------------------------------------------------------
// Checks before a dialog closes and before Save. DBGate checked nothing, so an empty name or a
// key over no column reached the server as SQL that could only fail.

export interface ModelProblem {
  section: TableModelSection | "table";
  /** The item the problem is about; absent for the table itself. */
  id?: string;
  message: string;
}

/** SQLite and MySQL compare column names without case; Postgres does not. */
function nameKey(name: string, dialect: DialectName): string {
  return dialect === "postgres" ? name : name.toLowerCase();
}

/**
 * Another key or index of the model already goes by `name`, as the engine compares names — what
 * a dialog says before Save would find two of one name. A primary key's name counts only where
 * the engine gives it one (Postgres).
 */
export function keyNameTaken(model: TableModel, id: string, name: string, dialect: DialectName): boolean {
  const wanted = name.trim();
  if (!wanted) return false;
  const others: [string, string | null][] = [
    ...model.indexes.map((x) => [x.id, x.name] as [string, string]),
    ...model.uniques.map((x) => [x.id, x.name] as [string, string | null]),
    ...model.foreignKeys.map((x) => [x.id, x.name] as [string, string | null]),
    ...(model.primaryKey && dialect === "postgres" ? [[model.primaryKey.id, model.primaryKey.name] as [string, string | null]] : []),
  ];
  return others.some(([other, n]) => other !== id && !!n?.trim() && nameKey(n.trim(), dialect) === nameKey(wanted, dialect));
}

const INTEGER_TYPE = /^(tiny|small|medium|big)?int(eger)?\b|^int[248]\b|^(small|big)?serial\b/i;

/** What stops the column dialog from closing. */
export function columnProblems(model: TableModel, column: TableModelColumn, dialect: DialectName): string[] {
  const problems: string[] = [];
  const name = column.name.trim();
  if (!name) problems.push("Column name is required");
  else if (model.columns.some((c) => c.id !== column.id && nameKey(c.name, dialect) === nameKey(name, dialect))) {
    problems.push(`There is already a column named ${name}`);
  }
  if (!column.type.trim()) problems.push("Data type is required");
  if (column.autoIncrement && !INTEGER_TYPE.test(column.type.trim())) problems.push("An autoincrement column needs an integer type");
  if (column.autoIncrement && column.computedExpression) problems.push("A computed column cannot be autoincrement");
  return problems;
}

/** What stops the primary key, index or unique dialog from closing. */
export function keyProblems(model: TableModel, columns: readonly (string | null)[], kind: "primaryKey" | "index" | "unique"): string[] {
  const problems: string[] = [];
  const chosen = columns.filter((c): c is string => c !== null);
  const label = kind === "primaryKey" ? "A primary key" : kind === "index" ? "An index" : "A unique constraint";
  if (columns.length === 0) problems.push(`${label} needs at least one column`);
  if (chosen.some((c) => !columnById(model, c))) problems.push("Choose a column for every row");
  if (new Set(chosen).size !== chosen.length) problems.push("A column is listed twice");
  return problems;
}

/** What stops the foreign key dialog from closing. */
export function foreignKeyProblems(model: TableModel, fk: TableModelForeignKey): string[] {
  const problems: string[] = [];
  if (!fk.refTable) problems.push("Choose the referenced table");
  if (fk.columns.length === 0) problems.push("A foreign key needs at least one column");
  if (fk.columns.length !== fk.refColumns.length || fk.columns.some((c) => !columnById(model, c)) || fk.refColumns.some((r) => !r)) {
    problems.push("Choose a base column and a referenced column for every row");
  }
  return problems;
}

/**
 * Everything Save refuses: each item's own problems, plus what only the whole table shows — two
 * items of one name, and an autoincrement the engine would reject.
 */
export function tableModelProblems(model: TableModel, dialect: DialectName): ModelProblem[] {
  const problems: ModelProblem[] = [];
  if (!model.name.trim()) problems.push({ section: "table", message: "Table name is required" });
  if (model.columns.length === 0) problems.push({ section: "table", message: "A table needs at least one column" });
  for (const c of model.columns) for (const message of columnProblems(model, c, dialect)) problems.push({ section: "columns", id: c.id, message });
  if (model.primaryKey) {
    for (const message of keyProblems(model, model.primaryKey.columns, "primaryKey")) problems.push({ section: "primaryKey", id: model.primaryKey.id, message });
  }
  for (const ix of model.indexes) {
    if (ix.columns.length === 0) problems.push({ section: "indexes", id: ix.id, message: "An index needs at least one column" });
    const parts = ix.columns.filter((k) => k.expression === null).map((k) => k.columnId);
    for (const message of keyProblems(model, parts, "index").filter((m) => !/at least one/.test(m))) problems.push({ section: "indexes", id: ix.id, message });
  }
  for (const u of model.uniques) for (const message of keyProblems(model, u.columns, "unique")) problems.push({ section: "uniques", id: u.id, message });
  for (const fk of model.foreignKeys) for (const message of foreignKeyProblems(model, fk)) problems.push({ section: "foreignKeys", id: fk.id, message });

  const named: { section: TableModelSection; id: string; name: string }[] = [
    ...model.indexes.map((x) => ({ section: "indexes" as const, id: x.id, name: x.name })),
    ...model.uniques.map((x) => ({ section: "uniques" as const, id: x.id, name: x.name ?? "" })),
    ...model.foreignKeys.map((x) => ({ section: "foreignKeys" as const, id: x.id, name: x.name ?? "" })),
    ...(model.primaryKey && dialect === "postgres" ? [{ section: "primaryKey" as const, id: model.primaryKey.id, name: model.primaryKey.name ?? "" }] : []),
  ].filter((x) => x.name.trim() !== "");
  const seen = new Map<string, string>();
  for (const x of named) {
    const key = nameKey(x.name.trim(), dialect);
    if (seen.has(key)) problems.push({ section: x.section, id: x.id, message: `Two keys or indexes are named ${x.name.trim()}` });
    else seen.set(key, x.id);
  }

  const auto = model.columns.filter((c) => c.autoIncrement);
  if (dialect === "mysql") {
    if (auto.length > 1) problems.push({ section: "columns", id: auto[1]!.id, message: "MySQL allows one autoincrement column per table" });
    for (const c of auto) {
      // MySQL: "there can be only one auto column and it must be defined as a key".
      const leads = (cols: readonly (string | null)[]) => cols[0] === c.id;
      const keyed = leads(model.primaryKey?.columns ?? []) || model.uniques.some((u) => leads(u.columns)) || model.indexes.some((ix) => leads(ix.columns.map((k) => k.columnId)));
      if (!keyed) problems.push({ section: "columns", id: c.id, message: `${c.name} is autoincrement, so MySQL needs it to lead the primary key or an index` });
    }
  }
  if (dialect === "sqlite") {
    for (const c of auto) {
      // Only the rowid itself counts up, and a column is the rowid only as the whole INTEGER PRIMARY KEY.
      const sole = model.primaryKey?.columns.length === 1 && model.primaryKey.columns[0] === c.id;
      if (!sole) problems.push({ section: "columns", id: c.id, message: `In SQLite only a column that is the whole primary key can be autoincrement (${c.name})` });
    }
    if (model.withoutRowid && auto.length > 0) problems.push({ section: "columns", id: auto[0]!.id, message: "A WITHOUT ROWID table has no autoincrement" });
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Names Save gives what the user left unnamed, DBGate's: PK_<table>, FK_<table>_<cols>, IX_…, UQ_…

export function autoConstraintName(kind: "PK" | "FK" | "IX" | "UQ", table: string, columns: readonly string[]): string {
  return kind === "PK" ? `PK_${table}` : `${kind}_${table}_${columns.join("_")}`;
}
