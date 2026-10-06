/**
 * What every database tab reads first: the target its metadata names, the saved connection behind
 * it — from the Database sidebar's list, which a tab restored before the sidebar has mounted reads
 * itself — the engine, and the place further tabs are opened on. A tab a URL opened knows only
 * ids, so it is given the connection's name, engine and colour, and its title, once they are known.
 */
import { useEffect, useMemo } from "react";
import { useTabStore } from "@/stores/tab-store";
import { dbObjectTabTitle, fileDisplayName, targetOf, type DbTarget } from "@/lib/db-tabs";
import { dialectNameOf, type DbType, type DialectName } from "../../../shared/db-types";
import { loadConnections, useDbExplorer } from "./explorer/db-explorer-store";
import { placeOf, type DbTabPlace } from "./explorer/open-db-tabs";
import type { Connection } from "./use-connections";

export interface DbTabContext {
  target: DbTarget | null;
  /** The saved connection, once the list has it; always undefined for a file. */
  conn: Connection | undefined;
  dbType: DbType | undefined;
  dialect: DialectName | undefined;
  /** The connection's name, or for a file the file's. */
  name: string;
  /** Where the tabs this one opens go; null when it names no target. */
  place: DbTabPlace | null;
  /** The connection refuses writes. A file never does. */
  readonly: boolean;
  /** The list has been read and holds no such connection: it was deleted. */
  missing: boolean;
}

export function useDbTab(metadata: Record<string, unknown> | undefined, tabId: string | undefined): DbTabContext {
  // Keyed by value: the metadata object is replaced on every update of the tab.
  const targetKey = JSON.stringify(targetOf(metadata));
  const target = useMemo(() => JSON.parse(targetKey) as DbTarget | null, [targetKey]);
  const connId = target?.kind === "connection" ? target.connectionId : null;
  const conn = useDbExplorer((s) => (connId === null ? undefined : s.connections.find((c) => c.id === connId)));
  const loaded = useDbExplorer((s) => s.loaded);
  useEffect(() => {
    if (connId !== null && !loaded) void loadConnections();
  }, [connId, loaded]);

  const dbType: DbType | undefined = target?.kind === "file" ? "sqlite" : conn?.type ?? (metadata?.dbType as DbType | undefined);
  const name = target?.kind === "file"
    ? fileDisplayName(target.path)
    : conn?.name ?? (typeof metadata?.connectionName === "string" ? metadata.connectionName : "Database");
  const color = conn?.color ?? (typeof metadata?.connectionColor === "string" ? metadata.connectionColor : null);

  const updateTab = useTabStore((s) => s.updateTab);
  useEffect(() => {
    if (!tabId || !conn || typeof metadata?.connectionName === "string") return;
    const objectName = (metadata?.tableName ?? metadata?.objectName) as string | undefined;
    updateTab(tabId, {
      metadata: { ...metadata, connectionName: conn.name, dbType: conn.type, ...(conn.color ? { connectionColor: conn.color } : {}) },
      ...(objectName && metadata?.queryId === undefined ? { title: dbObjectTabTitle(target, conn.name, objectName) } : {}),
    });
  }, [tabId, conn, metadata, target, updateTab]);

  const place = useMemo(
    () => (target ? placeOf(target, { connectionName: name, dbType, connectionColor: color }) : null),
    [target, name, dbType, color],
  );

  return {
    target, conn, dbType, dialect: dbType ? dialectNameOf(dbType) : undefined, name, place,
    readonly: conn?.readonly === 1,
    missing: connId !== null && loaded && !conn,
  };
}
