/**
 * What the SQL editor completes from: the target's tables and views, then a table's columns when
 * one is named. The connection's own database is read from PPM's table cache; another database of
 * its server, or a database file, from its catalog.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api-client";
import { targetUrl, type DbTarget } from "@/lib/db-tabs";
import type { DbObjectList } from "../../../../shared/db-structure";
import { KINDS_WITH_COLUMNS } from "../explorer/explorer-model";
import type { SchemaInfo } from "../sql-completion-provider";

type TableName = { name: string; schema: string };

export function useSqlSchemaInfo(target: DbTarget | null): SchemaInfo | undefined {
  const [tables, setTables] = useState<TableName[]>([]);

  useEffect(() => {
    setTables([]);
    if (!target) return;
    let live = true;
    const read: Promise<TableName[]> = target.kind === "connection" && target.database === undefined
      ? api.get<TableName[]>(targetUrl(target, "/tables?cached=1"))
      : api.get<DbObjectList>(targetUrl(target, "/objects"))
        .then((list) => list.objects.filter((o) => KINDS_WITH_COLUMNS.has(o.kind)).map((o) => ({ name: o.name, schema: o.schema ?? "" })));
    // Completion is a nicety: a target that cannot be read says so where it is run.
    read.then((t) => { if (live) setTables(t.map(({ name, schema }) => ({ name, schema }))); }).catch(() => {});
    return () => { live = false; };
  }, [target]);

  return useMemo<SchemaInfo | undefined>(() => {
    if (!target || tables.length === 0) return undefined;
    return {
      tables,
      getColumns: (table, schema) => api.get<{ name: string; type: string }[]>(targetUrl(
        target, `/schema?table=${encodeURIComponent(table)}${schema ? `&schema=${encodeURIComponent(schema)}` : ""}`,
      )),
    };
  }, [target, tables]);
}
