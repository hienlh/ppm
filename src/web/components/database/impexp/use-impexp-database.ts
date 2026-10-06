/**
 * The database side of an Import/Export tab as it stands: the saved connection, whether it takes
 * writes, a server's databases, the objects and schemas of the database, and the tables and views
 * of the schema in force — read from the target's routes as the other database tabs read them, so
 * the lists are read again when the tab is shown after another one.
 */
import { useEffect, useMemo } from "react";
import { fileDisplayName, type DbTarget } from "@/lib/db-tabs";
import { useSettingsStore } from "@/stores/settings-store";
import { dialectNameOf, type DbType, type DialectName } from "../../../../shared/db-types";
import type { DbObject, DbObjectList } from "../../../../shared/db-structure";
import { loadConnections, useDbExplorer } from "../explorer/db-explorer-store";
import {
  KINDS_WITH_COLUMNS, dbKey, hasSchemaChoice, initialSchema, isSingleDatabase, ownDatabase, schemaOptions, visibleDatabases,
} from "../explorer/explorer-model";
import type { Connection } from "../use-connections";
import { useDbRead, type DbRead } from "../use-db-read";
import type { ImpExpDatabase } from "./impexp-state";

export interface ImpExpDbContext {
  target: DbTarget | null;
  conn: Connection | undefined;
  /** The connection refuses writes, so nothing is imported into it. A file never does. */
  readonly: boolean;
  dbType: DbType | undefined;
  dialect: DialectName | undefined;
  /** The database's name, as the tab's title shows it; null while there is none. */
  name: string | null;
  /** A server's databases, as its Advanced tab lets them be seen, by name; null for one database or a file. */
  databases: DbRead<string[]> | null;
  objects: DbRead<DbObjectList>;
  /** Postgres's schemas; none where the engine has no choice to make. */
  schemas: string[];
  /** The schema the Schema box shows, which Run sends; null where there is none. */
  schema: string | null;
  /** The tables, views and materialized views of that schema. */
  relations: DbObject[];
}

export function useImpExpDatabase(db: ImpExpDatabase, tabId: string | undefined): ImpExpDbContext {
  // Keyed by value: the form is replaced on every change.
  const key = JSON.stringify(db.target);
  const target = useMemo(() => JSON.parse(key) as DbTarget | null, [key]);
  const connId = target?.kind === "connection" ? target.connectionId : null;
  const conn = useDbExplorer((s) => (connId === null ? undefined : s.connections.find((c) => c.id === connId)));
  const loaded = useDbExplorer((s) => s.loaded);
  useEffect(() => { if (!loaded) void loadConnections(); }, [loaded]);

  const server: DbTarget | null = conn && !isSingleDatabase(conn) ? { kind: "connection", connectionId: conn.id } : null;
  const listed = useDbRead<string[]>(server, server ? "/databases" : null, tabId);
  const visible = conn && listed.data ? [...visibleDatabases(conn, listed.data)].sort((a, b) => a.localeCompare(b)) : null;
  const databases = server ? { ...listed, data: visible } : null;

  const objects = useDbRead<DbObjectList>(target, target ? "/objects" : null, tabId);

  const choice = !!conn && hasSchemaChoice(conn.type);
  const schemas = useMemo(() => (choice && objects.data ? schemaOptions(objects.data) : []), [choice, objects.data]);
  const ref = target?.kind === "connection" && conn ? { conn: conn.id, database: target.database ?? ownDatabase(conn) } : null;
  const remembered = useSettingsStore((s) => (ref ? s.dbExplorerView.schemas[dbKey(ref)] : undefined));
  const schema = choice ? db.schema ?? initialSchema(schemas, remembered) : null;
  const relations = useMemo(
    () => (objects.data?.objects ?? []).filter((o) => KINDS_WITH_COLUMNS.has(o.kind) && (schema === null || o.schema === schema)),
    [objects.data, schema],
  );

  const dbType: DbType | undefined = target?.kind === "file" ? "sqlite" : conn?.type;
  const name = target?.kind === "file"
    ? fileDisplayName(target.path)
    : target ? target.database ?? (conn ? ownDatabase(conn) ?? conn.name : null) : null;

  return {
    target, conn, readonly: conn?.readonly === 1, dbType, dialect: dbType ? dialectNameOf(dbType) : undefined, name,
    databases, objects, schemas: schemas.map((s) => s.schema), schema, relations,
  };
}
