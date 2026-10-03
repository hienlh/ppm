/**
 * What the table editor shows of a model and offers for its fields, per engine: the rows of each
 * section, the data types and MySQL storage engines its lists suggest, the choices of its selects,
 * and what Copy definitions writes. Pure, so it is tested without a browser.
 */
import type { DbObjectList, DbStructureColumn, FkAction } from "../../../../shared/db-structure";
import type { DbType, DialectName } from "../../../../shared/db-types";
import {
  columnName, declaredType, isSelfReference, type TableModel, type TableModelColumn, type TableModelForeignKey,
  type TableModelIndex, type TableModelIndexColumn,
} from "../../../../shared/db-table-model";
import { columnDefinition } from "../structure/structure-model";

// DBGate's lists, its drivers' `predefinedDataTypes`. SQLite's five type affinities rather than
// DBGate's list for it, which never reached its editor (the generic list showed instead).
const DATA_TYPES: Record<DialectName, readonly string[]> = {
  postgres: [
    "bigint", "bigserial", "bit", "varbit", "boolean", "box", "bytea", "char(20)", "varchar(250)", "cidr", "circle", "date",
    "double precision", "inet", "int", "interval", "json", "jsonb", "line", "lseg", "macaddr", "macaddr8", "money", "decimal",
    "numeric(10,2)", "path", "pg_lsn", "pg_snapshot", "point", "polygon", "real", "smallint", "smallserial", "serial", "text",
    "time", "timetz", "timestamp", "timestamptz", "tsquery", "tsvector", "txid_snapshot", "uuid", "xml",
  ],
  mysql: [
    "char(20)", "varchar(250)", "binary(250)", "varbinary(250)", "tinyblob", "tinytext", "text(1000)", "blob(1000)", "mediumtext",
    "mediumblob", "longtext", "longblob", "enum('val1','val2','val3')", "set('val1','val2','val3')", "bit(32)", "tinyint", "bool",
    "smallint", "mediumint", "int", "bigint", "float", "double", "decimal", "date", "datetime", "timestamp", "time", "year",
  ],
  sqlite: ["INTEGER", "REAL", "TEXT", "BLOB", "NUMERIC"],
};

export function dataTypesFor(dialect: DialectName): readonly string[] {
  return DATA_TYPES[dialect];
}

// DBGate's `getSupportedEngines`, which differs between the two products.
const ENGINES: Partial<Record<DbType, readonly string[]>> = {
  mysql: [
    "InnoDB", "MyISAM", "MEMORY", "CSV", "ARCHIVE", "BLACKHOLE", "FEDERATED", "MRG_MYISAM", "NDB", "EXAMPLE",
    "PERFORMANCE_SCHEMA", "SEQUENCE", "SPIDER", "ROCKSDB", "TokuDB",
  ],
  mariadb: [
    "InnoDB", "Aria", "MyISAM", "MEMORY", "CSV", "ARCHIVE", "BLACKHOLE", "FEDERATED", "MRG_MyISAM", "SEQUENCE", "SphinxSE",
    "SPIDER", "TokuDB", "RocksDB", "CONNECT", "OQGRAPH", "ColumnStore", "Mroonga", "S3", "XtraDB",
  ],
};

/** The storage engines the Engine field suggests; none outside MySQL and MariaDB, which have no such field. */
export function enginesFor(dbType: DbType): readonly string[] {
  return ENGINES[dbType] ?? [];
}

/** MySQL and SQLite give a primary key no name of their own, so its dialog has no name field. */
export function primaryKeyHasName(dialect: DialectName): boolean {
  return dialect === "postgres";
}

// ─── Section rows ────────────────────────────────────────────────────────────

export interface EditorColumnRow {
  id: string;
  /** 1-based, DBGate's `#`. */
  ordinal: number;
  name: string;
  /** In the primary key, else in a foreign key, else neither: the icon beside the name. */
  role: "pk" | "fk" | null;
  notNull: boolean;
  type: string;
  defaultValue: string;
  computedExpression: string;
  comment: string;
  unsigned: boolean;
  zerofill: boolean;
}

export function editorColumnRows(model: TableModel): EditorColumnRow[] {
  const pk = new Set(model.primaryKey?.columns ?? []);
  const fk = new Set(model.foreignKeys.flatMap((k) => k.columns));
  return model.columns.map((c, i) => ({
    id: c.id,
    ordinal: i + 1,
    name: c.name,
    role: pk.has(c.id) ? "pk" : fk.has(c.id) ? "fk" : null,
    notNull: c.notNull,
    type: c.type,
    defaultValue: c.defaultValue ?? "",
    computedExpression: c.computedExpression ?? "",
    comment: c.comment ?? "",
    unsigned: c.unsigned,
    zerofill: c.zerofill,
  }));
}

export interface EditorKeyRow {
  id: string;
  name: string | null;
  columns: string;
}

const names = (model: TableModel, ids: readonly string[]) => ids.map((id) => columnName(model, id)).join(", ");

/** An index part as the list names it: its column, or the expression it is on. */
function partLabel(model: TableModel, part: TableModelIndexColumn): string {
  return part.columnId !== null ? columnName(model, part.columnId) : part.expression ?? "";
}

export function primaryKeyRow(model: TableModel): EditorKeyRow | null {
  const pk = model.primaryKey;
  return pk ? { id: pk.id, name: pk.name, columns: names(model, pk.columns) } : null;
}

export function uniqueRows(model: TableModel): EditorKeyRow[] {
  return model.uniques.map((u) => ({ id: u.id, name: u.name, columns: names(model, u.columns) }));
}

export function indexRows(model: TableModel): (EditorKeyRow & { unique: boolean })[] {
  return model.indexes.map((ix) => ({
    id: ix.id,
    // Empty until Save names it.
    name: ix.name || null,
    columns: ix.columns.map((p) => partLabel(model, p)).join(", "),
    unique: ix.unique,
  }));
}

export interface EditorForeignKeyRow {
  id: string;
  name: string | null;
  baseColumns: string;
  /** Schema-qualified only when it is not the table's own schema. */
  refTable: string;
  refColumns: string;
  onUpdate: string;
  onDelete: string;
}

/** `schema.table`, or the name alone in the table's own schema. */
export function refTableLabel(fk: Pick<TableModelForeignKey, "refSchema" | "refTable">, ownSchema: string | null): string {
  return fk.refSchema && fk.refSchema !== ownSchema ? `${fk.refSchema}.${fk.refTable}` : fk.refTable;
}

export function foreignKeyRows(model: TableModel): EditorForeignKeyRow[] {
  return model.foreignKeys.map((fk) => ({
    id: fk.id,
    name: fk.name,
    baseColumns: names(model, fk.columns),
    refTable: refTableLabel(fk, model.schema),
    refColumns: fk.refColumns.join(", "),
    onUpdate: fk.onUpdate ?? "",
    onDelete: fk.onDelete ?? "",
  }));
}

// ─── Copy ────────────────────────────────────────────────────────────────────

function asStructureColumn(c: TableModelColumn, dialect: DialectName): DbStructureColumn {
  return {
    name: c.name,
    type: declaredType(c, dialect),
    nullable: !c.notNull,
    defaultValue: c.defaultValue,
    comment: c.comment,
    autoIncrement: c.autoIncrement,
    generated: !!c.computedExpression,
    computedExpression: c.computedExpression,
  };
}

/** "Copy definitions" of the columns `ids` names, in the table's order, as the Structure tab writes them. */
export function modelColumnDefinitions(model: TableModel, ids: ReadonlySet<string>, dialect: DialectName): string {
  return model.columns.filter((c) => ids.has(c.id)).map((c) => columnDefinition(asStructureColumn(c, dialect), dialect)).join(",\n");
}

/** "Copy names" of the columns `ids` names, in the table's order. */
export function modelColumnNames(model: TableModel, ids: ReadonlySet<string>): string {
  return model.columns.filter((c) => ids.has(c.id)).map((c) => c.name).join(", ");
}

// ─── Choices ─────────────────────────────────────────────────────────────────

export interface Choice<T> {
  value: T;
  label: string;
}

const FK_ACTION_LABELS: Record<FkAction, string> = {
  "NO ACTION": "No Action",
  CASCADE: "Cascade",
  RESTRICT: "Restrict",
  "SET NULL": "Set Null",
  "SET DEFAULT": "Set Default",
};

/**
 * DBGate's On update / On delete choices. SET DEFAULT is not among them, so it is offered only to
 * a key that already has it — choosing another action is then a change the person made, not one
 * the dialog made by having nothing to show.
 */
export function fkActionChoices(current: FkAction | null): Choice<FkAction | null>[] {
  const actions: FkAction[] = ["NO ACTION", "CASCADE", "RESTRICT", "SET NULL", ...(current === "SET DEFAULT" ? ["SET DEFAULT" as const] : [])];
  return [{ value: null, label: "(not selected)" }, ...actions.map((a) => ({ value: a, label: FK_ACTION_LABELS[a] }))];
}

/** MySQL's Index type: DBGate's Normal, Unique, Fulltext, and an index's own other type (Spatial, Hash) kept on offer. */
export function mysqlIndexType(ix: Pick<TableModelIndex, "unique" | "method">): string {
  return ix.method ? ix.method.toLowerCase() : ix.unique ? "unique" : "normal";
}

export function mysqlIndexTypeChoices(ix: Pick<TableModelIndex, "unique" | "method">): Choice<string>[] {
  const base = [{ value: "normal", label: "Normal" }, { value: "unique", label: "Unique" }, { value: "fulltext", label: "Fulltext" }];
  const own = mysqlIndexType(ix);
  return base.some((c) => c.value === own) ? base : [...base, { value: own, label: own[0]!.toUpperCase() + own.slice(1) }];
}

export function withMysqlIndexType<T extends Pick<TableModelIndex, "unique" | "method">>(ix: T, type: string): T {
  if (type === mysqlIndexType(ix)) return ix;
  if (type === "normal") return { ...ix, unique: false, method: null };
  if (type === "unique") return { ...ix, unique: true, method: null };
  return { ...ix, unique: false, method: type };
}

export interface TableChoice {
  schema: string | null;
  name: string;
  label: string;
}

/** Every table a foreign key can point at, as `schema.table`, by schema and then by name. */
export function referencedTableChoices(list: Pick<DbObjectList, "objects">): TableChoice[] {
  return list.objects
    .filter((o) => o.kind === "table")
    .map((o) => ({ schema: o.schema, name: o.name, label: o.schema ? `${o.schema}.${o.name}` : o.name }))
    .sort((a, b) => (a.schema ?? "").localeCompare(b.schema ?? "") || a.name.localeCompare(b.name));
}

/** A choice's value in a native select: schema and name, which neither can contain both halves of. */
export function tableChoiceKey(t: Pick<TableChoice, "schema" | "name">): string {
  return `${t.schema ?? ""}\u0000${t.name}`;
}

/** "Add column N": one past the columns the table has. */
export function nextColumnNumber(model: TableModel): number {
  return model.columns.length + 1;
}

/** A new table's name or schema changed, its keys onto itself following it there. */
export function withTableName(model: TableModel, patch: { name?: string; schema?: string | null }): TableModel {
  const next = { ...model, ...patch };
  return {
    ...next,
    foreignKeys: model.foreignKeys.map((fk) => (isSelfReference(model, fk) ? { ...fk, refTable: next.name, refSchema: next.schema } : fk)),
  };
}
