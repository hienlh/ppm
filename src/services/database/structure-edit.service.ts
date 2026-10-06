/**
 * The table editor's Save and the tree's structure commands. A change is always planned against
 * the table as the database has it now, not as the browser remembers it: an edit made on a table
 * that has changed since the editor read it is refused (409) rather than applied to a table it was
 * never meant for, and a rename or a drop of a column starts from the live table too.
 */
import type { StructureChange, StructurePreview } from "../../shared/db-structure-change.ts";
import type { DbTableStructure } from "../../shared/db-structure.ts";
import { dialectNameOf, type DialectName } from "../../shared/db-types.ts";
import {
  modelFromStructure, removeColumns, sameTableModel, tableModelProblems, upsertColumn, type TableModel,
} from "../../shared/db-table-model.ts";
import { backupTablePlan, createTablePlan, dropTablePlan, renameTablePlan, truncateTablePlan } from "./ddl/ddl-objects.ts";
import { DdlUnsupportedError, ddlScript, type DdlPlan } from "./ddl/ddl-types.ts";
import { diffTableModels, isEmptyDiff } from "./ddl/table-diff.ts";
import type { GridTarget } from "./grid.service.ts";
import { StructureRequestError } from "./structure-change-request.ts";

export interface PreparedStructureChange {
  plan: DdlPlan;
  dialect: DialectName;
  /** The table the change is about, as the audit log names it. */
  schema: string | null;
  table: string;
}

const label = (schema: string | null, table: string) => (schema ? `${schema}.${table}` : table);

/** The table as the database has it now; 404 when it is gone, 400 when it is not a table. */
async function liveTable(target: GridTarget, schema: string | null, table: string): Promise<DbTableStructure> {
  const live = await target.adapter.getStructure(target.config, table, schema ?? undefined);
  if (!live) throw new StructureRequestError(`Table ${label(schema, table)} not found`, 404);
  if (live.kind !== "table") throw new StructureRequestError(`${label(schema, table)} is a ${live.kind === "foreign" ? "foreign table" : "view"}, not a table`);
  return live;
}

/** 409 when the name is taken by a table or view (they share one namespace). */
async function assertFree(target: GridTarget, schema: string | null, name: string): Promise<void> {
  if (await target.adapter.getStructure(target.config, name, schema ?? undefined)) {
    throw new StructureRequestError(`There is already a table or view named ${label(schema, name)}`, 409);
  }
}

function assertValid(model: TableModel, dialect: DialectName): void {
  const problems = tableModelProblems(model, dialect);
  if (problems.length > 0) throw new StructureRequestError([...new Set(problems.map((p) => p.message))].join("; "));
}

const EMPTY: DdlPlan = { statements: [], recreate: false, warnings: [] };

/** The alter plan from `base`, which is the live table, to `current`. */
async function alterPlan(target: GridTarget, dialect: DialectName, live: DbTableStructure, base: TableModel, current: TableModel): Promise<DdlPlan> {
  if (current.name !== base.name || (current.schema ?? null) !== (base.schema ?? null)) {
    throw new StructureRequestError("The table editor does not rename a table; use Rename table in the tree");
  }
  assertValid(current, dialect);
  const diff = diffTableModels(base, current);
  if (isEmptyDiff(diff)) return EMPTY;
  return target.adapter.planAlterTable(target.config, base, current, diff, live.references);
}

async function planFor(target: GridTarget, dialect: DialectName, change: StructureChange): Promise<{ plan: DdlPlan; schema: string | null; table: string }> {
  switch (change.kind) {
    case "alter": {
      const { base, current } = change;
      const live = await liveTable(target, base.schema, base.name);
      if (!sameTableModel(modelFromStructure(live, dialect), base)) {
        throw new StructureRequestError(`${label(base.schema, base.name)} has changed since the editor read it. Reload the structure and make the change again.`, 409);
      }
      return { plan: await alterPlan(target, dialect, live, base, current), schema: base.schema, table: base.name };
    }
    case "create": {
      const model = change.current;
      assertValid(model, dialect);
      await assertFree(target, model.schema, model.name);
      return { plan: createTablePlan(dialect, model), schema: model.schema, table: model.name };
    }
    case "drop-table": {
      const live = await liveTable(target, change.schema, change.table);
      return { plan: dropTablePlan(dialect, live, live.references), schema: change.schema, table: change.table };
    }
    case "truncate-table": {
      const live = await liveTable(target, change.schema, change.table);
      return { plan: truncateTablePlan(dialect, live, live.references), schema: change.schema, table: change.table };
    }
    case "rename-table": {
      const live = await liveTable(target, change.schema, change.table);
      const newName = change.newName.trim();
      if (newName === live.name) throw new StructureRequestError(`${live.name} already has that name`);
      // MySQL and SQLite find the table itself under a name differing only in case.
      if (dialect === "postgres" || newName.toLowerCase() !== live.name.toLowerCase()) await assertFree(target, change.schema, newName);
      return { plan: renameTablePlan(dialect, live, newName), schema: change.schema, table: change.table };
    }
    case "backup-table": {
      const live = await liveTable(target, change.schema, change.table);
      const newName = change.newName.trim();
      await assertFree(target, change.schema, newName);
      return { plan: backupTablePlan(dialect, modelFromStructure(live, dialect), newName), schema: change.schema, table: change.table };
    }
    case "rename-column":
    case "drop-column": {
      const live = await liveTable(target, change.schema, change.table);
      const base = modelFromStructure(live, dialect);
      const column = base.columns.find((c) => c.name === change.column);
      if (!column) throw new StructureRequestError(`Column ${change.column} not found in ${label(change.schema, change.table)}`, 404);
      let current: TableModel;
      if (change.kind === "rename-column") {
        const newName = change.newName.trim();
        if (newName === column.name) throw new StructureRequestError(`${column.name} already has that name`);
        current = upsertColumn(base, { ...column, name: newName });
      } else {
        current = removeColumns(base, [column.id]);
      }
      return { plan: await alterPlan(target, dialect, live, base, current), schema: change.schema, table: change.table };
    }
  }
}

/**
 * The plan for a change, checked against the live database. Throws `StructureRequestError` for a
 * change that cannot be made as asked (400), names what is not there (404) or was read from a
 * table that has changed since (409); `DdlUnsupportedError` becomes a 400 of its own.
 */
export async function prepareStructureChange(target: GridTarget, change: StructureChange): Promise<PreparedStructureChange> {
  const dialect = dialectNameOf(target.type);
  try {
    const { plan, schema, table } = await planFor(target, dialect, change);
    return { plan, dialect, schema, table };
  } catch (e) {
    if (e instanceof DdlUnsupportedError) throw new StructureRequestError(e.message);
    throw e;
  }
}

export function structurePreview(prepared: PreparedStructureChange): StructurePreview {
  return {
    sql: ddlScript(prepared.plan.statements),
    statements: prepared.plan.statements.map((s) => (s.phase ? { sql: ddlScript([s]), phase: s.phase } : { sql: ddlScript([s]) })),
    recreate: prepared.plan.recreate,
    warnings: prepared.plan.warnings,
    transactional: prepared.dialect !== "mysql",
  };
}
