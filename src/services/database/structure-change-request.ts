/**
 * Reading a structure change off the wire. The table editor's models arrive as JSON, so each field
 * is checked for its type here before a generator writes it into DDL: a model that is not one
 * answers 400 rather than failing somewhere inside a generator.
 */
import type { StructureApplyRequest, StructureChange } from "../../shared/db-structure-change.ts";
import type { DbCheckConstraint, FkAction } from "../../shared/db-structure.ts";
import type {
  TableModel, TableModelColumn, TableModelForeignKey, TableModelIndex, TableModelIndexColumn, TableModelPrimaryKey, TableModelUnique,
} from "../../shared/db-table-model.ts";

export class StructureRequestError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = "StructureRequestError";
  }
}

type Json = Record<string, unknown>;

const FK_ACTIONS = new Set<FkAction>(["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"]);

function fail(field: string, what: string): never {
  throw new StructureRequestError(`${field} must be ${what}`);
}

function object(value: unknown, field: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(field, "an object");
  return value as Json;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") fail(field, "a string");
  return value;
}

/** A name the request gives: something to write, not only spaces. */
function name(value: unknown, field: string): string {
  const s = string(value, field);
  if (!s.trim()) throw new StructureRequestError(`${field} is required`);
  return s;
}

/** Absent reads as null, which is how the model says "none". */
function nullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return string(value, field);
}

/** Absent reads as false: a model that went through JSON drops nothing else. */
function flag(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") fail(field, "true or false");
  return value;
}

function list<T>(value: unknown, field: string, item: (v: unknown, f: string) => T): T[] {
  if (!Array.isArray(value)) fail(field, "an array");
  return value.map((v, i) => item(v, `${field}[${i}]`));
}

function fkAction(value: unknown, field: string): FkAction | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !FK_ACTIONS.has(value as FkAction)) fail(field, "a foreign key action");
  return value as FkAction;
}

function column(value: unknown, field: string): TableModelColumn {
  const o = object(value, field);
  const identity = o.identity ?? null;
  if (identity !== null && identity !== "always" && identity !== "default") fail(`${field}.identity`, `"always", "default" or null`);
  return {
    id: name(o.id, `${field}.id`),
    name: string(o.name, `${field}.name`),
    type: string(o.type, `${field}.type`),
    notNull: flag(o.notNull, `${field}.notNull`),
    autoIncrement: flag(o.autoIncrement, `${field}.autoIncrement`),
    defaultValue: nullableString(o.defaultValue, `${field}.defaultValue`),
    computedExpression: nullableString(o.computedExpression, `${field}.computedExpression`),
    comment: nullableString(o.comment, `${field}.comment`),
    unsigned: flag(o.unsigned, `${field}.unsigned`),
    zerofill: flag(o.zerofill, `${field}.zerofill`),
    collation: nullableString(o.collation, `${field}.collation`),
    computedStored: flag(o.computedStored, `${field}.computedStored`),
    onUpdate: nullableString(o.onUpdate, `${field}.onUpdate`),
    identity,
    sqliteAutoincrement: flag(o.sqliteAutoincrement, `${field}.sqliteAutoincrement`),
  };
}

function indexColumn(value: unknown, field: string): TableModelIndexColumn {
  const o = object(value, field);
  const part: TableModelIndexColumn = {
    columnId: nullableString(o.columnId, `${field}.columnId`),
    expression: nullableString(o.expression, `${field}.expression`),
    descending: flag(o.descending, `${field}.descending`),
  };
  if (part.columnId === null && part.expression === null) fail(field, "a column or an expression");
  if (o.nulls !== undefined) {
    if (o.nulls !== "first" && o.nulls !== "last") fail(`${field}.nulls`, `"first" or "last"`);
    part.nulls = o.nulls;
  }
  if (o.length !== undefined) {
    if (typeof o.length !== "number" || !Number.isInteger(o.length) || o.length <= 0) fail(`${field}.length`, "a positive whole number");
    part.length = o.length;
  }
  if (o.opclass !== undefined) part.opclass = string(o.opclass, `${field}.opclass`);
  return part;
}

function primaryKey(value: unknown, field: string): TableModelPrimaryKey | null {
  if (value === null || value === undefined) return null;
  const o = object(value, field);
  return { id: name(o.id, `${field}.id`), name: nullableString(o.name, `${field}.name`), columns: list(o.columns, `${field}.columns`, string) };
}

function index(value: unknown, field: string): TableModelIndex {
  const o = object(value, field);
  return {
    id: name(o.id, `${field}.id`),
    name: string(o.name ?? "", `${field}.name`),
    columns: list(o.columns, `${field}.columns`, indexColumn),
    unique: flag(o.unique, `${field}.unique`),
    method: nullableString(o.method, `${field}.method`),
    where: nullableString(o.where, `${field}.where`),
  };
}

function unique(value: unknown, field: string): TableModelUnique {
  const o = object(value, field);
  return { id: name(o.id, `${field}.id`), name: nullableString(o.name, `${field}.name`), columns: list(o.columns, `${field}.columns`, string) };
}

function foreignKey(value: unknown, field: string): TableModelForeignKey {
  const o = object(value, field);
  return {
    id: name(o.id, `${field}.id`),
    name: nullableString(o.name, `${field}.name`),
    columns: list(o.columns, `${field}.columns`, string),
    refSchema: nullableString(o.refSchema, `${field}.refSchema`),
    refTable: string(o.refTable, `${field}.refTable`),
    refColumns: list(o.refColumns, `${field}.refColumns`, string),
    onUpdate: fkAction(o.onUpdate, `${field}.onUpdate`),
    onDelete: fkAction(o.onDelete, `${field}.onDelete`),
  };
}

function check(value: unknown, field: string): DbCheckConstraint {
  const o = object(value, field);
  const c: DbCheckConstraint = { name: nullableString(o.name, `${field}.name`), expression: string(o.expression, `${field}.expression`) };
  if (o.column !== undefined) c.column = string(o.column, `${field}.column`);
  return c;
}

export function parseTableModel(value: unknown, field: string): TableModel {
  const o = object(value, field);
  const model: TableModel = {
    schema: nullableString(o.schema, `${field}.schema`),
    name: string(o.name, `${field}.name`),
    columns: list(o.columns, `${field}.columns`, column),
    primaryKey: primaryKey(o.primaryKey, `${field}.primaryKey`),
    indexes: list(o.indexes ?? [], `${field}.indexes`, index),
    uniques: list(o.uniques ?? [], `${field}.uniques`, unique),
    foreignKeys: list(o.foreignKeys ?? [], `${field}.foreignKeys`, foreignKey),
    checks: list(o.checks ?? [], `${field}.checks`, check),
    comment: nullableString(o.comment, `${field}.comment`),
    engine: nullableString(o.engine, `${field}.engine`),
    withoutRowid: flag(o.withoutRowid, `${field}.withoutRowid`),
    strict: flag(o.strict, `${field}.strict`),
  };
  // Items pair up by id: two with one id would pair with each other's counterparts.
  const ids = [
    ...model.columns.map((c) => c.id), ...model.indexes.map((x) => x.id), ...model.uniques.map((x) => x.id),
    ...model.foreignKeys.map((x) => x.id), ...(model.primaryKey ? [model.primaryKey.id] : []),
  ];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new StructureRequestError(`${field} has two items with the id ${id}`);
    seen.add(id);
  }
  return model;
}

/** A structure change, or StructureRequestError saying what is wrong with it. */
export function parseStructureChange(value: unknown): StructureChange {
  const o = object(value, "change");
  const schema = () => nullableString(o.schema, "change.schema");
  const table = () => name(o.table, "change.table");
  switch (o.kind) {
    case "alter":
      return { kind: "alter", base: parseTableModel(o.base, "change.base"), current: parseTableModel(o.current, "change.current") };
    case "create":
      return { kind: "create", current: parseTableModel(o.current, "change.current") };
    case "drop-table":
    case "truncate-table":
      return { kind: o.kind, schema: schema(), table: table() };
    case "rename-table":
    case "backup-table":
      return { kind: o.kind, schema: schema(), table: table(), newName: name(o.newName, "change.newName") };
    case "rename-column":
      return { kind: "rename-column", schema: schema(), table: table(), column: name(o.column, "change.column"), newName: name(o.newName, "change.newName") };
    case "drop-column":
      return { kind: "drop-column", schema: schema(), table: table(), column: name(o.column, "change.column") };
    default:
      throw new StructureRequestError("change.kind is not a structure change PPM knows");
  }
}

export function parseStructureApply(value: unknown): StructureApplyRequest {
  const o = object(value, "request");
  const request: StructureApplyRequest = { change: parseStructureChange(o.change), allowRecreate: flag(o.allowRecreate, "allowRecreate") };
  if (o.sql !== undefined) request.sql = string(o.sql, "sql");
  return request;
}
