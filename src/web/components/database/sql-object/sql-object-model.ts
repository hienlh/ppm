/**
 * What the SQL tab offers for one object — its CREATE under the name of what it is, and a table's
 * or view's SELECT and a table's INSERT — and the request for them. Pure, for tests.
 */
import type { DbScriptKind } from "@/lib/db-tabs";
import type { DbObjectKind, DbObjectRef, DbObjectScripts } from "../../../../shared/db-structure";

const CREATE_LABELS: Record<DbObjectKind, string> = {
  table: "CREATE TABLE",
  view: "CREATE VIEW",
  matview: "CREATE MATERIALIZED VIEW",
  function: "CREATE FUNCTION",
  procedure: "CREATE PROCEDURE",
  trigger: "CREATE TRIGGER",
  sequence: "CREATE SEQUENCE",
};

export interface ScriptChoice { kind: DbScriptKind; label: string; sql: string }

/** The scripts in DBGate's order, the CREATE labelled with what the object is; none before they arrive. */
export function scriptChoices(kind: DbObjectKind, scripts: DbObjectScripts | null): ScriptChoice[] {
  if (!scripts) return [];
  const out: ScriptChoice[] = [{ kind: "create", label: CREATE_LABELS[kind], sql: scripts.create }];
  if (scripts.select !== undefined) out.push({ kind: "select", label: "SELECT", sql: scripts.select });
  if (scripts.insert !== undefined) out.push({ kind: "insert", label: "INSERT", sql: scripts.insert });
  return out;
}

/**
 * `GET …/object-sql` for `ref`. An empty `args` is sent: it is a routine that takes none, which is
 * one overload of several as much as any other.
 */
export function objectSqlPath(ref: DbObjectRef): string {
  const enc = encodeURIComponent;
  return `/object-sql?kind=${enc(ref.kind)}&name=${enc(ref.name)}`
    + (ref.schema ? `&schema=${enc(ref.schema)}` : "")
    + (ref.args !== undefined ? `&args=${enc(ref.args)}` : "")
    + (ref.table ? `&table=${enc(ref.table)}` : "");
}
