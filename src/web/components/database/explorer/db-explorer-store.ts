/**
 * The Database sidebar's live state, kept the way DBGate keeps its tree: the saved connections,
 * which of them are open and how opening them went, and what has been read of each database — a
 * server's list of databases, a database's objects, a table's columns. One store because both
 * sections read it and the tabs drive it: the object list follows the database of the active tab.
 *
 * What comes back after a reload is not held here but in the settings store, which this only
 * reads and writes: `dbExplorer` (open connections, expanded nodes, folders — synced to the
 * server) and `dbExplorerView` (the current database, the split, the searches — this device).
 */
import { create } from "zustand";
import { api, ApiError } from "@/lib/api-client";
import { missingDbDriverOf, type MissingDbDriver } from "@/lib/db-drivers";
import type { DbTarget } from "@/lib/db-tabs";
import { useSettingsStore } from "@/stores/settings-store";
import { useTabStore } from "@/stores/tab-store";
import { asksForPassword } from "../../../../shared/db-connection-config";
import type { DbExplorerPrefs, DbExplorerView } from "../../../../shared/db-explorer-prefs";
import type { DbColumnRef, DbObjectList, DbTableStructure } from "../../../../shared/db-structure";
import type { Connection } from "../use-connections";
import { useDbSidebarReveal, type DbConnectionsChangedDetail } from "../db-sidebar-reveal";
import {
  connOfNodeKey, databaseParam, dbKey, folderNames, ownDatabase, sameDb, singleDbRef, tabDbRef, withDatabaseParam,
  type DbRef,
} from "./explorer-model";

/** A read from the server: under way, done, or refused — with the driver to offer when that is why. */
export type Loaded<T> =
  | { state: "loading" }
  | { state: "ready"; data: T }
  | { state: "error"; message: string; driver: MissingDbDriver | null };

/** DBGate's ✓, spinner and ! on a connection. No entry: the tree has not opened it. */
export type ConnStatus =
  | { state: "connecting" }
  | { state: "open" }
  | { state: "error"; message: string; driver: MissingDbDriver | null };

export interface DbExplorerState {
  connections: Connection[];
  /** The list has been read at least once; a restored tree waits for it. */
  loaded: boolean;
  /** Why the list could not be read, when it could not. */
  listError: string | null;
  status: Record<number, ConnStatus>;
  /** A server connection's databases, as the server lists them (the Advanced tab's filter applies on display). */
  databases: Record<number, Loaded<string[]>>;
  /** A database's objects, by `dbKey`. */
  objects: Record<string, Loaded<DbObjectList>>;
  /** Every column of a database, by `dbKey` — read only for searching by column. */
  allColumns: Record<string, Loaded<DbColumnRef[]>>;
  /** One table's or view's structure — its columns and keys shown under it — by `objectNodeKey`. */
  structures: Record<string, Loaded<DbTableStructure>>;
  /** The row picked in the tree (DBGate's focused connection or database). */
  focused: DbRef | null;
  connectionQuery: string;
  objectQuery: string;
  /** Structure changes saved on a connection, counted: a tab showing something of it reads it again. */
  structureChanges: Record<number, number>;
}

export const useDbExplorer = create<DbExplorerState>(() => ({
  connections: [],
  loaded: false,
  listError: null,
  status: {},
  databases: {},
  objects: {},
  allColumns: {},
  structures: {},
  focused: null,
  connectionQuery: "",
  objectQuery: "",
  structureChanges: {},
}));

// ─── Prefs, through the settings store ───────────────────────────────────────

const prefs = (): DbExplorerPrefs => useSettingsStore.getState().dbExplorer;
const view = (): DbExplorerView => useSettingsStore.getState().dbExplorerView;

function updatePrefs(change: (p: DbExplorerPrefs) => DbExplorerPrefs): void {
  const current = prefs();
  const next = change(current);
  if (next !== current) useSettingsStore.getState().setDbExplorer(next);
}

function updateView(patch: Partial<DbExplorerView>): void {
  useSettingsStore.getState().setDbExplorerView({ ...view(), ...patch });
}

/** For the sections: the device-local view prefs (split, collapsed sections, search fields, sort). */
export const setExplorerView = updateView;

export function setConnectionQuery(connectionQuery: string): void {
  useDbExplorer.setState({ connectionQuery });
}

export function setObjectQuery(objectQuery: string): void {
  useDbExplorer.setState({ objectQuery });
}

const withItem = <T>(list: T[], item: T): T[] => (list.includes(item) ? list : [...list, item]);
const without = <T>(list: T[], item: T): T[] => (list.includes(item) ? list.filter((x) => x !== item) : list);

/** The database the object list shows. */
export function currentDatabase(): DbRef | null {
  return view().current;
}

export function connectionById(id: number): Connection | undefined {
  return useDbExplorer.getState().connections.find((c) => c.id === id);
}

/** A connection that asks for its password and for which the server holds none: reading it opens Database Log In. */
function needsLogin(c: Connection): boolean {
  return asksForPassword(c.password_mode) && !c.logged_in;
}

// ─── State kept per connection ───────────────────────────────────────────────

type MapField = "status" | "databases" | "objects" | "allColumns" | "structures";

function put<K extends MapField>(field: K, key: string | number, value: DbExplorerState[K][keyof DbExplorerState[K]] | undefined): void {
  useDbExplorer.setState((s) => {
    const next = { ...(s[field] as Record<string, unknown>) };
    if (value === undefined) delete next[key];
    else next[key] = value;
    return { [field]: next } as Pick<DbExplorerState, K>;
  });
}

/**
 * Bumped when the tree forgets a connection, so an answer to a request made before — a
 * Disconnect while its databases were still being read — is dropped rather than stored.
 */
const generations = new Map<number, number>();
const generationOf = (id: number) => generations.get(id) ?? 0;

const keyOfConn = (key: string) => Number(key.slice(0, key.indexOf("/")));

function forgetConnectionState(id: number): void {
  generations.set(id, generationOf(id) + 1);
  connecting.delete(id);
  useDbExplorer.setState((s) => {
    const byConn = <T>(map: Record<string, T>, connOf: (key: string) => number) =>
      Object.fromEntries(Object.entries(map).filter(([k]) => connOf(k) !== id));
    const { [id]: _status, ...status } = s.status;
    const { [id]: _dbs, ...databases } = s.databases;
    return {
      status, databases,
      objects: byConn(s.objects, keyOfConn),
      allColumns: byConn(s.allColumns, keyOfConn),
      structures: byConn(s.structures, connOfNodeKey),
    };
  });
}

/** The error a failed read leaves, or null when it failed only because Database Log In was closed. */
function failureOf(e: unknown): Extract<Loaded<never>, { state: "error" }> | null {
  if (e instanceof ApiError && e.status === 428) return null;
  return { state: "error", message: (e as Error).message || "The request failed", driver: missingDbDriverOf(e) };
}

class LoginCancelled extends Error {}

/** One read of `url` into `field[key]`; dropped when the connection was forgotten meanwhile. */
async function readInto<K extends Exclude<MapField, "status">>(field: K, key: string | number, conn: number, url: string): Promise<void> {
  const generation = generationOf(conn);
  put(field, key, { state: "loading" } as DbExplorerState[K][keyof DbExplorerState[K]]);
  try {
    const data = await api.get<unknown>(url);
    if (generationOf(conn) === generation) put(field, key, { state: "ready", data } as DbExplorerState[K][keyof DbExplorerState[K]]);
  } catch (e) {
    if (generationOf(conn) !== generation) return;
    const failure = failureOf(e);
    put(field, key, (failure ?? undefined) as DbExplorerState[K][keyof DbExplorerState[K]] | undefined);
    throw failure ? e : new LoginCancelled();
  }
}

const base = (id: number) => `/api/db/connections/${id}`;

function urlFor(ref: DbRef, path: string): string | null {
  const conn = connectionById(ref.conn);
  return conn ? withDatabaseParam(`${base(ref.conn)}${path}`, databaseParam(ref, conn)) : null;
}

/**
 * The command palette searches the tables PPM last listed for each connection, which only
 * `GET /tables` refreshes: the tree asks for it whenever it opens or refreshes a connection.
 */
function refreshTableCache(id: number): void {
  api.get(`${base(id)}/tables`).catch(() => { /* the palette keeps its older list */ });
}

// ─── The connection list ─────────────────────────────────────────────────────

let listSeq = 0;

export async function loadConnections(): Promise<void> {
  const seq = ++listSeq;
  try {
    const list = await api.get<Connection[]>("/api/db/connections");
    if (seq !== listSeq) return;
    useDbExplorer.setState({ connections: list, loaded: true, listError: null });
    tidyAfterList(list);
  } catch (e) {
    if (seq === listSeq) useDbExplorer.setState({ loaded: true, listError: (e as Error).message || "Could not read the connections" });
  }
}

/**
 * Forgets what the tree kept for connections that are gone, closes the ones whose login the
 * server no longer holds (a restart, an edit), and drops a folder made empty in the tree once
 * a connection is in it.
 */
function tidyAfterList(list: Connection[]): void {
  const ids = new Set(list.map((c) => c.id));
  const s = useDbExplorer.getState();
  const known = new Set<number>([
    ...Object.keys(s.status).map(Number), ...Object.keys(s.databases).map(Number),
    ...Object.keys(s.objects).map(keyOfConn), ...Object.keys(s.structures).map(connOfNodeKey),
  ]);
  for (const id of known) if (!ids.has(id)) forgetConnectionState(id);
  const loggedOut = list.filter((c) => needsLogin(c) && s.status[c.id]?.state === "open").map((c) => c.id);
  for (const id of loggedOut) forgetConnectionState(id);

  const inUse = new Set(list.map((c) => c.group_name).filter(Boolean));
  updatePrefs((p) => {
    const opened = p.opened.filter((id) => ids.has(id) && !loggedOut.includes(id));
    const expandedConns = p.expandedConns.filter((id) => ids.has(id) && !loggedOut.includes(id));
    const expandedObjects = p.expandedObjects.filter((k) => ids.has(connOfNodeKey(k)));
    const emptyFolders = p.emptyFolders.filter((f) => !inUse.has(f));
    const same = opened.length === p.opened.length && expandedConns.length === p.expandedConns.length
      && expandedObjects.length === p.expandedObjects.length && emptyFolders.length === p.emptyFolders.length;
    return same ? p : { ...p, opened, expandedConns, expandedObjects, emptyFolders };
  });

  const v = view();
  const schemas = Object.fromEntries(Object.entries(v.schemas).filter(([k]) => ids.has(keyOfConn(k))));
  const current = v.current && ids.has(v.current.conn) && !loggedOut.includes(v.current.conn) ? v.current : null;
  if (current !== v.current || Object.keys(schemas).length !== Object.keys(v.schemas).length) updateView({ current, schemas });
  const focused = useDbExplorer.getState().focused;
  if (focused && !ids.has(focused.conn)) useDbExplorer.setState({ focused: null });
}

// ─── Opening and closing connections ─────────────────────────────────────────

const connecting = new Map<number, Promise<boolean>>();

/**
 * Opens a connection in the tree: reads a server's databases, or a single database's objects.
 * Resolves true once open; false when it failed (the row then shows why) or Database Log In was
 * closed (the row stays as it was). `expand` also opens a server's database list.
 */
export function connectConnection(id: number, options: { expand?: boolean } = {}): Promise<boolean> {
  const conn = connectionById(id);
  if (!conn) return Promise.resolve(false);
  if (useDbExplorer.getState().status[id]?.state === "open") {
    if (options.expand && !singleDbRef(conn)) updatePrefs((p) => ({ ...p, expandedConns: withItem(p.expandedConns, id) }));
    return Promise.resolve(true);
  }
  const running = connecting.get(id);
  if (running) return running;

  const generation = generationOf(id);
  const single = singleDbRef(conn);
  const attempt = (async () => {
    put("status", id, { state: "connecting" });
    updatePrefs((p) => ({ ...p, opened: withItem(p.opened, id) }));
    try {
      if (single) await readInto("objects", dbKey(single), id, urlFor(single, "/objects")!);
      else await readInto("databases", id, id, `${base(id)}/databases`);
    } catch (e) {
      if (generationOf(id) !== generation) return false;
      if (e instanceof LoginCancelled) {
        put("status", id, undefined);
        updatePrefs((p) => ({ ...p, opened: without(p.opened, id) }));
        return false;
      }
      const failure = failureOf(e)!;
      put("status", id, { state: "error", message: failure.message, driver: failure.driver });
      return false;
    }
    if (generationOf(id) !== generation) return false;
    put("status", id, { state: "open" });
    if (options.expand && !single) updatePrefs((p) => ({ ...p, expandedConns: withItem(p.expandedConns, id) }));
    refreshTableCache(id);
    return true;
  })();
  connecting.set(id, attempt);
  void attempt.then(() => { if (connecting.get(id) === attempt) connecting.delete(id); });
  return attempt;
}

/**
 * Closes a connection: its pools on the server and every database it opened, a login lent for it
 * (the next connect asks again), and all the tree read of it. Its tabs stay open.
 */
export async function disconnectConnection(id: number): Promise<void> {
  forgetConnectionState(id);
  updatePrefs((p) => ({ ...p, opened: without(p.opened, id), expandedConns: without(p.expandedConns, id) }));
  if (view().current?.conn === id) updateView({ current: null });
  await api.post(`${base(id)}/disconnect`).catch(() => { /* the tree has let it go either way */ });
  void loadConnections();
}

/** Disconnect and connect again, keeping a login PPM holds for it; the current database is read again. */
export async function reconnectConnection(id: number): Promise<void> {
  await api.post(`${base(id)}/disconnect`, { keepLogin: true }).catch(() => {});
  forgetConnectionState(id);
  const expanded = prefs().expandedConns.includes(id);
  if (!(await connectConnection(id, { expand: expanded }))) return;
  const current = view().current;
  if (current?.conn === id) void loadObjects(current);
}

/** The connection's Refresh: a server's database list, or a single database's objects, read again. */
export async function refreshConnection(id: number): Promise<void> {
  const conn = connectionById(id);
  if (!conn || useDbExplorer.getState().status[id]?.state !== "open") return;
  const single = singleDbRef(conn);
  if (single) await refreshDatabase(single);
  else await readInto("databases", id, id, `${base(id)}/databases`).catch(() => {});
  refreshTableCache(id);
}

/** Refresh structure: the object list read again. A full refresh also drops the columns read of it. */
export async function refreshDatabase(ref: DbRef, options: { full?: boolean } = {}): Promise<void> {
  const key = dbKey(ref);
  if (options.full) {
    useDbExplorer.setState((s) => ({
      allColumns: Object.fromEntries(Object.entries(s.allColumns).filter(([k]) => k !== key)),
      structures: Object.fromEntries(Object.entries(s.structures).filter(([k]) => !k.startsWith(`${key}|`))),
    }));
  }
  await loadObjects(ref, { force: true });
}

/**
 * A table was created, changed, renamed or dropped through a saved connection: the tree reads that
 * database again, with the columns and keys shown under its tables, the palette its table list, and
 * every tab in view on the connection what it shows (`useDbRead`). A file's tables are listed by its
 * own tab, which reads them again when it is shown.
 */
export async function refreshAfterStructureChange(target: DbTarget): Promise<void> {
  if (target.kind !== "connection") return;
  const conn = useDbExplorer.getState().connections.find((c) => c.id === target.connectionId);
  if (!conn) return;
  useDbExplorer.setState((s) => ({ structureChanges: { ...s.structureChanges, [conn.id]: (s.structureChanges[conn.id] ?? 0) + 1 } }));
  refreshTableCache(conn.id);
  const database = target.database && conn.type !== "sqlite" ? target.database : ownDatabase(conn);
  await refreshDatabase({ conn: conn.id, database }, { full: true });
}

// ─── Reading a database ──────────────────────────────────────────────────────

export async function loadObjects(ref: DbRef, options: { force?: boolean } = {}): Promise<void> {
  const url = urlFor(ref, "/objects");
  const have = useDbExplorer.getState().objects[dbKey(ref)];
  if (!url || (!options.force && have && have.state !== "error")) return;
  await readInto("objects", dbKey(ref), ref.conn, url).catch(() => { /* the entry says why */ });
}

/** Every column of the database, for searching the tree by column name or type. */
export async function loadAllColumns(ref: DbRef): Promise<void> {
  const url = urlFor(ref, "/columns");
  if (!url || useDbExplorer.getState().allColumns[dbKey(ref)]) return;
  await readInto("allColumns", dbKey(ref), ref.conn, url).catch(() => {});
}

/**
 * One table's or view's structure, for its columns and keys shown under it in the tree. The
 * structure reader rather than `/schema`: Postgres's information_schema has no materialized views.
 */
export async function loadTableStructure(ref: DbRef, nodeKey: string, table: { schema: string | null; name: string }): Promise<void> {
  const have = useDbExplorer.getState().structures[nodeKey];
  if (have && have.state !== "error") return;
  const schema = table.schema ? `&schema=${encodeURIComponent(table.schema)}` : "";
  const url = urlFor(ref, `/structure?table=${encodeURIComponent(table.name)}${schema}`);
  if (url) await readInto("structures", nodeKey, ref.conn, url).catch(() => {});
}

// ─── Current and focused database ────────────────────────────────────────────

export function focusRow(ref: DbRef | null): void {
  if (!sameDb(useDbExplorer.getState().focused, ref)) useDbExplorer.setState({ focused: ref });
}

/**
 * Makes `ref` the database the object list shows, opening its connection first when it is not.
 * `focus` (the default) is an explicit choice, so the tree's pick moves there too; the active tab
 * changing it leaves the pick alone. Database Log In closed on the way puts back what was current.
 */
export async function setCurrentDatabase(ref: DbRef, options: { focus?: boolean } = {}): Promise<void> {
  const previous = view().current;
  if (!sameDb(previous, ref)) updateView({ current: ref });
  if (options.focus !== false) focusRow(ref);
  const opened = await connectConnection(ref.conn);
  if (!opened) {
    const status = useDbExplorer.getState().status[ref.conn];
    if (!status && sameDb(view().current, ref)) updateView({ current: previous });
    return;
  }
  await loadObjects(ref);
}

/** The database of the active tab, when it belongs to one. */
export function activeTabDatabase(): DbRef | null {
  const { tabs, activeTabId } = useTabStore.getState();
  return tabDbRef(tabs.find((t) => t.id === activeTabId), connectionById);
}

/**
 * A plain click on a database. It becomes current unless the active tab belongs to another
 * database: then the list stays with the tab and the tree asks, as DBGate does, whether to switch.
 */
export function pickDatabase(ref: DbRef): void {
  focusRow(ref);
  const tab = activeTabDatabase();
  if (tab && !sameDb(tab, ref)) return;
  void setCurrentDatabase(ref);
}

/** The prompt's "Show X": the tree's pick goes back to the current database. */
export function showCurrentDatabase(): void {
  focusRow(view().current);
}

/** The last tab the object list followed; undefined until it has followed one. */
let followedTabId: string | null | undefined;

/**
 * The object list follows the database of the tab that became active; the pick stays where it
 * was. Only a change of tab moves it — remounting the sidebar keeps a database switched to by hand.
 */
export function followActiveTab(): void {
  const { activeTabId } = useTabStore.getState();
  if (!useDbExplorer.getState().loaded || activeTabId === followedTabId) return;
  followedTabId = activeTabId;
  const ref = activeTabDatabase();
  if (ref && !sameDb(ref, view().current)) void setCurrentDatabase(ref, { focus: false });
}

/**
 * After a reload: open again what was open — but not a connection that would ask for its password,
 * which waits to be opened by hand — and read the current database. Connections the tree already
 * holds a state for are left alone, so remounting the sidebar retries nothing.
 */
export function restoreTree(): void {
  const s = useDbExplorer.getState();
  const blocked: number[] = [];
  for (const id of prefs().opened) {
    const conn = connectionById(id);
    if (!conn || s.status[id]) continue;
    if (needsLogin(conn)) blocked.push(id);
    else void connectConnection(id);
  }
  if (blocked.length) updatePrefs((p) => ({ ...p, opened: p.opened.filter((id) => !blocked.includes(id)) }));
  const current = view().current;
  const conn = current ? connectionById(current.conn) : undefined;
  if (current && conn && needsLogin(conn)) updateView({ current: null });
  else if (current && conn) void setCurrentDatabase(current, { focus: false });
}

/**
 * A connection saved from its tab with Connect: a single database — or a server's default one —
 * becomes current; a server without one opens its database list. What the tree read of it before
 * the save is dropped first: the server closed it, and it may point elsewhere now.
 */
export async function openSavedConnection(id: number): Promise<void> {
  const conn = connectionById(id);
  if (!conn) return;
  forgetConnectionState(id);
  const single = singleDbRef(conn);
  const own = ownDatabase(conn);
  if (!(await connectConnection(id, { expand: !single }))) return;
  if (single) await setCurrentDatabase(single);
  else if (own) await setCurrentDatabase({ conn: id, database: own });
  else focusRow({ conn: id, database: null });
}

/**
 * A connection saved from its tab without Connect. Open in the tree, it is read again, since the
 * server closed it and it may point elsewhere now — unless it now asks for a password, when the
 * tree closes it. Not open, only the palette's table list is refreshed.
 */
export async function refreshEditedConnection(id: number): Promise<void> {
  const conn = connectionById(id);
  if (!conn) return;
  if (!useDbExplorer.getState().status[id]) {
    refreshTableCache(id);
    return;
  }
  forgetConnectionState(id);
  const current = view().current;
  if (current?.conn === id) {
    const single = singleDbRef(conn);
    if (single && !sameDb(single, current)) updateView({ current: single });
  }
  if (needsLogin(conn)) {
    updatePrefs((p) => ({ ...p, opened: without(p.opened, id), expandedConns: without(p.expandedConns, id) }));
    return;
  }
  if (!(await connectConnection(id))) return;
  const now = view().current;
  if (now?.conn === id) void loadObjects(now);
}

/**
 * The saved connections changed elsewhere (`announceConnectionsChanged`): the list is read again,
 * then a connection the tab just connected is opened, or one it saved is read again.
 */
export async function onConnectionsChanged(detail: DbConnectionsChangedDetail): Promise<void> {
  await loadConnections();
  const id = detail.connectionId;
  if (id === undefined) return;
  if (useDbSidebarReveal.getState().expandId === id) {
    useDbSidebarReveal.setState({ expandId: null });
    await openSavedConnection(id);
  } else if (detail.refreshTables) {
    await refreshEditedConnection(id);
  }
}

/**
 * The sidebar mounted: the list read, a connection connected from its tab while the sidebar was
 * not showing opened, the tree restored, and the active tab followed.
 */
export async function startExplorer(): Promise<void> {
  await loadConnections();
  const pending = useDbSidebarReveal.getState().expandId;
  if (pending !== null && connectionById(pending)) {
    useDbSidebarReveal.setState({ expandId: null });
    void openSavedConnection(pending);
  }
  restoreTree();
  followActiveTab();
}

/** A driver was installed: every connection and database waiting for it is opened or read again. */
export function retryAfterDriverInstall(driverId: string): void {
  const s = useDbExplorer.getState();
  for (const [id, st] of Object.entries(s.status)) {
    if (st.state !== "error" || st.driver?.id !== driverId) continue;
    put("status", id, undefined);
    void connectConnection(Number(id));
  }
  const current = view().current;
  const entry = current ? s.objects[dbKey(current)] : undefined;
  if (current && entry?.state === "error" && entry.driver?.id === driverId) void loadObjects(current, { force: true });
}

// ─── Expansion ───────────────────────────────────────────────────────────────

export function toggleConnectionExpanded(id: number): void {
  updatePrefs((p) => ({ ...p, expandedConns: p.expandedConns.includes(id) ? without(p.expandedConns, id) : [...p.expandedConns, id] }));
}

export function toggleFolder(name: string): void {
  updatePrefs((p) => ({ ...p, collapsedFolders: p.collapsedFolders.includes(name) ? without(p.collapsedFolders, name) : [...p.collapsedFolders, name] }));
}

export function toggleObjectGroup(kind: DbExplorerPrefs["openGroups"][number]): void {
  updatePrefs((p) => ({ ...p, openGroups: p.openGroups.includes(kind) ? without(p.openGroups, kind) : [...p.openGroups, kind] }));
}

export function setObjectExpanded(nodeKey: string, expanded: boolean): void {
  updatePrefs((p) => ({ ...p, expandedObjects: expanded ? withItem(p.expandedObjects, nodeKey) : without(p.expandedObjects, nodeKey) }));
}

/** ⋮ Collapse all: every group closed, and every object of the current database. */
export function collapseAllObjects(): void {
  const current = view().current;
  const prefix = current ? `${dbKey(current)}|` : null;
  updatePrefs((p) => ({ ...p, openGroups: [], expandedObjects: prefix ? p.expandedObjects.filter((k) => !k.startsWith(prefix)) : p.expandedObjects }));
}

// ─── Folders ─────────────────────────────────────────────────────────────────

const allFolders = () => folderNames(useDbExplorer.getState().connections, prefs().emptyFolders);

/** Adds an empty folder; false when the name is blank or taken. */
export function createFolder(raw: string): boolean {
  const name = raw.trim();
  if (!name || allFolders().includes(name)) return false;
  updatePrefs((p) => ({ ...p, emptyFolders: [...p.emptyFolders, name] }));
  return true;
}

const hasConnectionsIn = (folder: string) => useDbExplorer.getState().connections.some((c) => c.group_name === folder);

/** Renames a folder by moving its connections; false when the name is blank, unchanged or taken. */
export async function renameFolder(from: string, raw: string): Promise<boolean> {
  const to = raw.trim();
  if (!to || to === from || allFolders().includes(to)) return false;
  if (hasConnectionsIn(from)) await api.post("/api/db/connections/folder", { from, to });
  updatePrefs((p) => ({
    ...p,
    emptyFolders: p.emptyFolders.map((f) => (f === from ? to : f)),
    collapsedFolders: p.collapsedFolders.map((f) => (f === from ? to : f)),
  }));
  await loadConnections();
  return true;
}

/** Deletes a folder; its connections move out of it, none is deleted. */
export async function deleteFolder(name: string): Promise<void> {
  if (hasConnectionsIn(name)) await api.post("/api/db/connections/folder", { from: name, to: null });
  updatePrefs((p) => ({ ...p, emptyFolders: without(p.emptyFolders, name), collapsedFolders: without(p.collapsedFolders, name) }));
  await loadConnections();
}

// ─── Connection actions ──────────────────────────────────────────────────────

/** Deletes the saved connection — never the database. */
export async function deleteConnection(id: number): Promise<void> {
  await api.del(`${base(id)}`);
  await loadConnections();
}

/** Duplicate: a copy under a free name, lit in the tree. */
export async function duplicateConnection(id: number): Promise<Connection> {
  const copy = await api.post<Connection>(`${base(id)}/duplicate`);
  await loadConnections();
  useDbSidebarReveal.setState({ revealId: copy.id });
  return copy;
}

export async function setConnectionReadonly(id: number, readonly: boolean): Promise<void> {
  const updated = await api.put<Connection>(`${base(id)}`, { readonly: readonly ? 1 : 0 });
  useDbExplorer.setState((s) => ({ connections: s.connections.map((c) => (c.id === id ? { ...c, ...updated } : c)) }));
}

export interface ConnectionsExport { version: number; exported_at: string; connections: unknown[] }

/** Every saved connection with its credentials, for a file the user keeps; decrypted by the server on purpose. */
export function exportConnections(): Promise<ConnectionsExport> {
  return api.get<ConnectionsExport>("/api/db/connections/export");
}

/** Connections read from an export: listed at once, and the palette told about their tables. */
export async function importConnections(data: { connections: unknown[] }): Promise<{ imported: number; skipped: number; errors: string[] }> {
  const result = await api.post<{ imported: number; skipped: number; errors: string[]; connections?: Connection[] }>("/api/db/connections/import", data);
  await loadConnections();
  for (const c of result.connections ?? []) refreshTableCache(c.id);
  return result;
}

/** For tests: back to a tree that has read nothing. */
export function _resetDbExplorer(): void {
  listSeq++;
  connecting.clear();
  generations.clear();
  followedTabId = undefined;
  useDbExplorer.setState(useDbExplorer.getInitialState(), true);
}
