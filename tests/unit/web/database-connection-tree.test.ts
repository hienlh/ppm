/**
 * The Connections section as rows, in DBGate's order: folders first with their connections, a
 * divider, then the connections in no folder; a server's databases under it once it is open and
 * expanded; bold for the current database, the pick for the focused one.
 */
import { describe, expect, it } from "bun:test";
import {
  connectionTreeRows, searchFoundNothing, type ConnectionTreeInput, type ConnectionTreeRow,
} from "../../../src/web/components/database/connections-section/connection-tree-model";
import type { TreeConnection } from "../../../src/web/components/database/explorer/explorer-model";

const conn = (over: Partial<TreeConnection> & { id: number; name: string }): TreeConnection => ({
  type: "postgres", group_name: null, color: null, readonly: 0, single_database: false, default_database: null, ...over,
});

const appDev = conn({ id: 1, name: "app-dev", group_name: "Local", server: "localhost:5432", user: "app" });
const shop = conn({ id: 2, name: "shop-mysql", type: "mysql", group_name: "Local", default_database: "shop" });
const notes = conn({ id: 3, type: "sqlite", name: "notes", single_database: true, server: "/data/notes.db" });
const billing = conn({ id: 4, name: "Billing", default_database: "billing", single_database: true });

function input(over: Partial<ConnectionTreeInput> = {}): ConnectionTreeInput {
  return {
    connections: [notes, appDev, billing, shop],
    status: {},
    databases: {},
    prefs: { collapsedFolders: [], emptyFolders: [], expandedConns: [] },
    current: null,
    focused: null,
    query: "",
    fields: ["name", "database"],
    creatingFolder: false,
    renamingFolder: null,
    ...over,
  };
}

/** A row as one short line: the kind, what it names, and its marks. */
function describeRow(r: ConnectionTreeRow): string {
  switch (r.kind) {
    case "folder": return `folder ${r.name} (${r.count})${r.open ? "" : " closed"}${r.renaming ? " renaming" : ""}`;
    case "connection": {
      const marks = [r.expandable && (r.expanded ? "−" : "+"), r.current && "bold", r.selected && "picked", r.status?.state].filter(Boolean);
      return `${"  ".repeat(r.depth)}${r.conn.name}${marks.length ? ` [${marks.join(" ")}]` : ""}`;
    }
    case "database": return `${"  ".repeat(r.depth)}db ${r.database}${r.current ? " [bold]" : ""}${r.selected ? " [picked]" : ""}`;
    case "databases-loading": return `${"  ".repeat(r.depth)}loading`;
    case "databases-error": return `${"  ".repeat(r.depth)}error ${r.message}`;
    default: return r.kind;
  }
}

const tree = (over: Partial<ConnectionTreeInput> = {}) => connectionTreeRows(input(over)).map(describeRow);

describe("the Connections tree", () => {
  it("puts folders first, then a divider, then the rest — each sorted by name", () => {
    expect(tree()).toEqual([
      "folder Local (2)",
      "  app-dev",
      "  shop-mysql",
      "separator",
      "Billing",
      "notes",
    ]);
  });

  it("keeps an empty folder made in the tree, and leaves out the divider when there is nothing above it", () => {
    expect(tree({ connections: [notes], prefs: { collapsedFolders: [], emptyFolders: ["Later"], expandedConns: [] } }))
      .toEqual(["folder Later (0)", "separator", "notes"]);
    expect(tree({ connections: [notes] })).toEqual(["notes"]);
  });

  it("hides a closed folder's connections", () => {
    expect(tree({ prefs: { collapsedFolders: ["Local"], emptyFolders: [], expandedConns: [] } }))
      .toEqual(["folder Local (2) closed", "separator", "Billing", "notes"]);
  });

  it("offers a server's databases only once it is open, and lists them while it is expanded", () => {
    expect(tree({ connections: [appDev] })).toEqual(["folder Local (1)", "  app-dev"]);
    const open = { status: { 1: { state: "open" as const } }, databases: { 1: { state: "ready" as const, data: ["reporting", "shop"] } } };
    expect(tree({ connections: [appDev], ...open })).toEqual(["folder Local (1)", "  app-dev [+ open]"]);
    expect(tree({ connections: [appDev], ...open, prefs: { collapsedFolders: [], emptyFolders: [], expandedConns: [1] } }))
      .toEqual(["folder Local (1)", "  app-dev [− open]", "    db reporting", "    db shop"]);
  });

  it("never expands a single database: a SQLite file, or a server connection that uses only its own", () => {
    const rows = connectionTreeRows(input({
      connections: [notes, billing],
      status: { 3: { state: "open" }, 4: { state: "open" } },
      prefs: { collapsedFolders: [], emptyFolders: [], expandedConns: [3, 4] },
    }));
    expect(rows.every((r) => r.kind !== "connection" || !r.expandable)).toBe(true);
    expect(rows.map(describeRow)).toEqual(["Billing [open]", "notes [open]"]);
  });

  it("shows the list being read, and why it could not be", () => {
    const expanded = { collapsedFolders: [], emptyFolders: [], expandedConns: [1] };
    expect(tree({ connections: [appDev], status: { 1: { state: "open" } }, databases: { 1: { state: "loading" } }, prefs: expanded }))
      .toEqual(["folder Local (1)", "  app-dev [− open]", "    loading"]);
    expect(tree({
      connections: [appDev], status: { 1: { state: "open" } }, prefs: expanded,
      databases: { 1: { state: "error", message: "permission denied", driver: null } },
    })).toEqual(["folder Local (1)", "  app-dev [− open]", "    error permission denied"]);
  });

  it("hides the databases the connection's Advanced tab leaves out", () => {
    const only = conn({ ...appDev, allowed_databases_regex: "^shop" });
    expect(tree({
      connections: [only], status: { 1: { state: "open" } },
      databases: { 1: { state: "ready", data: ["reporting", "shop", "shop_archive"] } },
      prefs: { collapsedFolders: [], emptyFolders: [], expandedConns: [1] },
    })).toEqual(["folder Local (1)", "  app-dev [− open]", "    db shop", "    db shop_archive"]);
  });

  it("marks the current database bold and the focused one picked — which are not the same thing", () => {
    const common = {
      connections: [appDev, notes],
      status: { 1: { state: "open" as const }, 3: { state: "open" as const } },
      databases: { 1: { state: "ready" as const, data: ["reporting", "shop"] } },
      prefs: { collapsedFolders: [], emptyFolders: [], expandedConns: [1] },
    };
    expect(tree({ ...common, current: { conn: 1, database: "shop" }, focused: { conn: 1, database: "reporting" } })).toEqual([
      "folder Local (1)",
      "  app-dev [− bold open]",
      "    db reporting [picked]",
      "    db shop [bold]",
      "separator",
      "notes [open]",
    ]);
    // A single database is its connection's row: bold and picked there.
    expect(tree({ ...common, current: { conn: 3, database: null }, focused: { conn: 3, database: null } }).at(-1))
      .toBe("notes [bold picked open]");
    // Focusing the server itself picks its row.
    expect(tree({ ...common, focused: { conn: 1, database: null } })[1]).toBe("  app-dev [− picked open]");
  });

  it("does not make a single database bold for another database of its connection", () => {
    // Left over from before the connection was narrowed to its own database.
    expect(tree({ connections: [billing], current: { conn: 4, database: "archive" } })).toEqual(["Billing"]);
    expect(tree({ connections: [billing], current: { conn: 4, database: "billing" } })).toEqual(["Billing [bold]"]);
  });

  it("shows the connecting spinner and the error on the row", () => {
    const rows = tree({
      connections: [notes, billing],
      status: { 3: { state: "connecting" }, 4: { state: "error", message: "timeout", driver: null } },
    });
    expect(rows).toEqual(["Billing [error]", "notes [connecting]"]);
  });

  it("puts the new folder's input first and marks the folder being renamed", () => {
    expect(tree({ creatingFolder: true, renamingFolder: "Local" }).slice(0, 2)).toEqual(["new-folder", "folder Local (2) renaming"]);
  });
});

describe("searching the Connections tree", () => {
  it("keeps only what matched, opening the folders that still hold something", () => {
    const rows = tree({ query: "shop", prefs: { collapsedFolders: ["Local"], emptyFolders: ["Empty"], expandedConns: [] } });
    expect(rows).toEqual(["folder Local (1)", "  shop-mysql"]);
  });

  it("lists a server's databases that matched when the server itself did not", () => {
    const rows = tree({
      query: "report",
      status: { 1: { state: "open" } },
      databases: { 1: { state: "ready", data: ["reporting", "shop"] } },
    });
    expect(rows).toEqual(["folder Local (1)", "  app-dev [− open]", "    db reporting"]);
  });

  it("searches only the fields picked in the filter", () => {
    expect(tree({ query: "localhost", fields: ["name"] })).toEqual([]);
    expect(tree({ query: "localhost", fields: ["server"] })).toEqual(["folder Local (1)", "  app-dev"]);
    expect(tree({ query: "mysql", fields: ["engine"] })).toEqual(["folder Local (1)", "  shop-mysql"]);
  });

  it("says when a search found nothing", () => {
    const rows = connectionTreeRows(input({ query: "nothing-like-this" }));
    expect(rows).toEqual([]);
    expect(searchFoundNothing(rows, "nothing-like-this")).toBe(true);
    expect(searchFoundNothing(connectionTreeRows(input({ query: "notes" })), "notes")).toBe(false);
    expect(searchFoundNothing([], "")).toBe(false);
  });
});
