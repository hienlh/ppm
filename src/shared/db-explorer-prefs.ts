/**
 * What the Database sidebar's tree remembers, and how a stored copy is read back.
 *
 * Two prefs. `dbExplorer` rides the server with the other UI prefs, so the tree comes back the same
 * after an origin change or on another device: which connections are open, which folders and nodes
 * are expanded, the folders made empty. `dbExplorerView` stays on the device: the current database
 * follows this browser's own tabs, and the split and the section states are about this screen.
 *
 * Shared because the server's ui-prefs validator checks `dbExplorer` against the same bounds the
 * browser writes it within.
 */
import type { DbObjectKind } from "./db-structure.ts";

export interface DbExplorerPrefs {
  /** Connections the tree shows connected (DBGate's opened connections). */
  opened: number[];
  /** Server connections with their database list open. */
  expandedConns: number[];
  collapsedFolders: string[];
  /** Folders made in the tree that no connection is in yet. */
  emptyFolders: string[];
  /** Object groups open: Tables, Views, … */
  openGroups: DbObjectKind[];
  /** Tables and views with their columns shown, by `conn/database|schema.name`. */
  expandedObjects: string[];
}

export interface DbExplorerView {
  /** The database the object list shows. */
  current: { conn: number; database: string | null } | null;
  /** The Connections section's share of the sidebar's height. */
  split: number;
  connectionsCollapsed: boolean;
  objectsCollapsed: boolean;
  connectionSearch: string[];
  objectSearch: string[];
  objectSort: "name" | "rows";
  onlyWithRows: boolean;
  /** The schema picked in each database, by `conn/database`. */
  schemas: Record<string, string>;
}

const OBJECT_KINDS: readonly DbObjectKind[] = ["table", "view", "matview", "function", "procedure", "trigger", "sequence"];

export const DB_EXPLORER_CAPS = { ids: 200, folders: 200, objects: 500, text: 300, schemas: 100 } as const;

export const SPLIT_MIN = 0.15;
export const SPLIT_MAX = 0.85;

export const DEFAULT_DB_EXPLORER: DbExplorerPrefs = {
  opened: [], expandedConns: [], collapsedFolders: [], emptyFolders: [], openGroups: ["table"], expandedObjects: [],
};

export const DEFAULT_DB_EXPLORER_VIEW: DbExplorerView = {
  current: null, split: 0.42, connectionsCollapsed: false, objectsCollapsed: false,
  connectionSearch: ["name", "database"], objectSearch: ["name"], objectSort: "name", onlyWithRows: false, schemas: {},
};

const isId = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x > 0;
const isText = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= DB_EXPLORER_CAPS.text;
const isKind = (x: unknown): x is DbObjectKind => OBJECT_KINDS.includes(x as DbObjectKind);

function list<T>(raw: unknown, keep: (x: unknown) => x is T, cap: number): T[] {
  return Array.isArray(raw) ? [...new Set(raw.filter(keep))].slice(-cap) : [];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A stored `dbExplorer` made usable: unknown entries dropped, lists bounded. Null when it is not one at all. */
export function sanitizeDbExplorer(value: unknown): DbExplorerPrefs | null {
  if (!isObject(value)) return null;
  return {
    opened: list(value.opened, isId, DB_EXPLORER_CAPS.ids),
    expandedConns: list(value.expandedConns, isId, DB_EXPLORER_CAPS.ids),
    collapsedFolders: list(value.collapsedFolders, isText, DB_EXPLORER_CAPS.folders),
    emptyFolders: list(value.emptyFolders, isText, DB_EXPLORER_CAPS.folders),
    openGroups: Array.isArray(value.openGroups) ? list(value.openGroups, isKind, OBJECT_KINDS.length) : DEFAULT_DB_EXPLORER.openGroups,
    expandedObjects: list(value.expandedObjects, isText, DB_EXPLORER_CAPS.objects),
  };
}

/** The server's check on a `dbExplorer` a browser sends: the shape, within the bounds the browser keeps. */
export function isDbExplorerPrefs(value: unknown): boolean {
  if (!isObject(value)) return false;
  const within = (raw: unknown, keep: (x: unknown) => boolean, cap: number) => Array.isArray(raw) && raw.length <= cap && raw.every(keep);
  return within(value.opened, isId, DB_EXPLORER_CAPS.ids)
    && within(value.expandedConns, isId, DB_EXPLORER_CAPS.ids)
    && within(value.collapsedFolders, isText, DB_EXPLORER_CAPS.folders)
    && within(value.emptyFolders, isText, DB_EXPLORER_CAPS.folders)
    && within(value.openGroups, isKind, OBJECT_KINDS.length)
    && within(value.expandedObjects, isText, DB_EXPLORER_CAPS.objects);
}

function clampSplit(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v)) : DEFAULT_DB_EXPLORER_VIEW.split;
}

/** A stored `dbExplorerView` made usable; null when it is not one at all. */
export function sanitizeDbExplorerView(value: unknown): DbExplorerView | null {
  if (!isObject(value)) return null;
  const d = DEFAULT_DB_EXPLORER_VIEW;
  const cur = value.current;
  const current = isObject(cur) && isId(cur.conn) && (cur.database === null || isText(cur.database))
    ? { conn: cur.conn, database: cur.database as string | null }
    : null;
  const schemas: Record<string, string> = {};
  if (isObject(value.schemas)) {
    for (const [k, v] of Object.entries(value.schemas).slice(-DB_EXPLORER_CAPS.schemas)) if (isText(k) && isText(v)) schemas[k] = v;
  }
  return {
    current,
    split: clampSplit(value.split),
    connectionsCollapsed: value.connectionsCollapsed === true,
    objectsCollapsed: value.objectsCollapsed === true,
    connectionSearch: Array.isArray(value.connectionSearch) ? list(value.connectionSearch, isText, 10) : d.connectionSearch,
    objectSearch: Array.isArray(value.objectSearch) ? list(value.objectSearch, isText, 10) : d.objectSearch,
    objectSort: value.objectSort === "rows" ? "rows" : "name",
    onlyWithRows: value.onlyWithRows === true,
    schemas,
  };
}
