/**
 * The Connections section as a flat list of rows, in DBGate's order: folders first (each with
 * its connections under it), a divider, then the connections in no folder — a server's databases
 * listed under it while it is open and expanded. Searching keeps only what matched, with every
 * folder that still holds something open.
 *
 * Pure, like `explorer-model`: the section renders what this returns and the keyboard walks it.
 */
import type { DbExplorerPrefs } from "../../../../shared/db-explorer-prefs";
import type { ConnStatus, Loaded } from "../explorer/db-explorer-store";
import {
  folderNames, isSingleDatabase, matchConnection, sameDb, singleDbRef, visibleDatabases,
  type ConnectionSearchField, type DbRef, type TreeConnection,
} from "../explorer/explorer-model";

export type ConnectionTreeRow =
  | { kind: "new-folder"; key: "new-folder" }
  | { kind: "folder"; key: string; name: string; count: number; open: boolean; renaming: boolean }
  | { kind: "separator"; key: "separator" }
  | {
    kind: "connection"; key: string; conn: TreeConnection; depth: number;
    /** Open with a database list to show (a server, connected). */
    expandable: boolean; expanded: boolean;
    current: boolean; selected: boolean; status: ConnStatus | undefined;
  }
  | { kind: "database"; key: string; conn: TreeConnection; database: string; depth: number; current: boolean; selected: boolean }
  | { kind: "databases-loading"; key: string; depth: number }
  | { kind: "databases-error"; key: string; depth: number; message: string };

export interface ConnectionTreeInput {
  connections: readonly TreeConnection[];
  status: Readonly<Record<number, ConnStatus>>;
  databases: Readonly<Record<number, Loaded<string[]>>>;
  prefs: Pick<DbExplorerPrefs, "collapsedFolders" | "emptyFolders" | "expandedConns">;
  current: DbRef | null;
  focused: DbRef | null;
  query: string;
  fields: readonly ConnectionSearchField[];
  creatingFolder: boolean;
  renamingFolder: string | null;
}

export const connectionRowKey = (id: number) => `conn:${id}`;
export const databaseRowKey = (id: number, database: string) => `db:${id}/${database}`;
export const folderRowKey = (name: string) => `folder:${name}`;

const byName = (a: TreeConnection, b: TreeConnection) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

export function connectionTreeRows(input: ConnectionTreeInput): ConnectionTreeRow[] {
  const { connections, status, databases, prefs, current, focused, query, fields } = input;
  const searching = query.trim() !== "";
  const collapsed = new Set(prefs.collapsedFolders);
  const expandedConns = new Set(prefs.expandedConns);
  const rows: ConnectionTreeRow[] = [];

  const listed = (c: TreeConnection) => {
    const d = databases[c.id];
    return d?.state === "ready" ? visibleDatabases(c, d.data) : undefined;
  };

  const connectionRows = (c: TreeConnection, depth: number, matchedDatabases: string[] | null) => {
    const single = isSingleDatabase(c);
    const open = status[c.id]?.state === "open";
    const expandable = !single && open;
    const expanded = expandable && (expandedConns.has(c.id) || matchedDatabases !== null);
    const own = singleDbRef(c);
    rows.push({
      kind: "connection", key: connectionRowKey(c.id), conn: c, depth, expandable, expanded,
      current: !!current && current.conn === c.id && (!single || sameDb(current, own)),
      selected: !!focused && focused.conn === c.id && (single ? sameDb(focused, own) : focused.database === null),
      status: status[c.id],
    });
    if (!expanded) return;
    const d = databases[c.id];
    if (d?.state === "loading") { rows.push({ kind: "databases-loading", key: `${connectionRowKey(c.id)}:loading`, depth: depth + 1 }); return; }
    if (d?.state === "error") { rows.push({ kind: "databases-error", key: `${connectionRowKey(c.id)}:error`, depth: depth + 1, message: d.message }); return; }
    for (const database of matchedDatabases ?? listed(c) ?? []) {
      const ref = { conn: c.id, database };
      rows.push({
        kind: "database", key: databaseRowKey(c.id, database), conn: c, database, depth: depth + 1,
        current: sameDb(current, ref), selected: sameDb(focused, ref),
      });
    }
  };

  const matching = (list: readonly TreeConnection[]) =>
    [...list].sort(byName)
      .map((c) => ({ c, m: matchConnection(c, query, fields, listed(c)) }))
      .filter(({ m }) => m.show);

  if (input.creatingFolder) rows.push({ kind: "new-folder", key: "new-folder" });

  let shown = 0;
  const folders = folderNames(connections, prefs.emptyFolders);
  for (const name of folders) {
    const kids = matching(connections.filter((c) => c.group_name === name));
    if (searching && kids.length === 0) continue;
    const open = searching || !collapsed.has(name);
    rows.push({ kind: "folder", key: folderRowKey(name), name, count: kids.length, open, renaming: input.renamingFolder === name });
    if (open) for (const { c, m } of kids) connectionRows(c, 1, m.databases);
    shown += kids.length;
  }

  const loose = matching(connections.filter((c) => !c.group_name));
  if (loose.length > 0 && (shown > 0 || (!searching && folders.length > 0))) rows.push({ kind: "separator", key: "separator" });
  for (const { c, m } of loose) connectionRows(c, 0, m.databases);
  return rows;
}

/** Whether a search left nothing to show. */
export function searchFoundNothing(rows: readonly ConnectionTreeRow[], query: string): boolean {
  return query.trim() !== "" && !rows.some((r) => r.kind === "connection");
}
