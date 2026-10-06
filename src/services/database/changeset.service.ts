/**
 * Build a changeset against the table's real columns and run it: what the
 * preview and apply routes, and the older single-row endpoints, all go through.
 */
import type { ChangesetApplyResult, ChangesetPreview } from "../../shared/db-changeset.ts";
import type { QueryOperation } from "../query-audit/query-audit.service.ts";
import { classifyColumnType, dialectFor } from "./dialects.ts";
import { buildChangeset, changesetScript, type BuiltChangeset, type ChangesetTable, type ValidChangeset } from "./changeset.ts";
import { GridTableNotFoundError, type GridTarget } from "./grid.service.ts";

export interface PreparedChangeset extends BuiltChangeset {
  table: ChangesetTable;
}

/** A table as a changeset addresses its rows, from the catalog. */
export async function describeChangesetTable(target: GridTarget, name: string, schema: string | null): Promise<ChangesetTable> {
  const described = await target.adapter.describeTable(target.config, name, schema ?? undefined);
  if (!described) throw new GridTableNotFoundError(schema ? `Table "${schema}.${name}" not found` : `Table "${name}" not found`);
  return {
    schema,
    name,
    columns: described.columns.map((c) => ({ ...c, kind: classifyColumnType(target.type, c.type) })),
    rowidAliases: described.rowidAliases,
  };
}

/** Check a changeset against the table's catalog and build its statements. */
export async function prepareChangeset(target: GridTarget, cs: ValidChangeset): Promise<PreparedChangeset> {
  const table = await describeChangesetTable(target, cs.table, cs.schema);
  // Only a delete can leave rows pointing at nothing, so only then is the whole
  // database's key list worth reading.
  const foreignKeys = cs.deletes.length > 0 ? await target.adapter.listForeignKeys(target.config) : [];
  return { table, ...buildChangeset(dialectFor(target.type), table, cs, foreignKeys) };
}

export function previewOf(prepared: PreparedChangeset): ChangesetPreview {
  const statements = prepared.statements.filter((s) => s.kind !== "cascade");
  return { script: changesetScript(statements), statementCount: statements.length, references: prepared.references };
}

export async function runChangeset(target: GridTarget, prepared: PreparedChangeset): Promise<ChangesetApplyResult> {
  const started = performance.now();
  const counts = prepared.statements.length > 0 ? await target.adapter.applyChangeset(target.config, prepared.statements) : [];
  const result: ChangesetApplyResult = { inserted: 0, updated: 0, deleted: 0, cascaded: 0, executionTimeMs: 0 };
  prepared.statements.forEach((s, i) => {
    const n = counts[i] ?? 0;
    if (s.kind === "insert") result.inserted += n;
    else if (s.kind === "update") result.updated += n;
    else if (s.kind === "delete") result.deleted += n;
    else result.cascaded += n;
  });
  result.executionTimeMs = Math.round(performance.now() - started);
  return result;
}

/** The audit log's word for a changeset: its one kind of change, or `script` for a mix. */
export function changesetOperation(cs: Pick<ValidChangeset, "inserts" | "updates" | "deletes">): QueryOperation {
  const kinds = (["insert", "update", "delete"] as const).filter((k) => cs[`${k}s`].length > 0);
  return kinds.length === 1 ? kinds[0]! : "script";
}
