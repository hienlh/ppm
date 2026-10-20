import { getSessionDesignSlug, getSessionTitle } from "../db.service.ts";
import { resolveTabTarget } from "../tab-tools-mcp/tab-target.ts";
import { ASSISTANT_TAB_KINDS, isAssistantTabKind, type AssistantOpenTabTarget } from "../../shared/assistant-ui-protocol.ts";
import { resolveAssistantSessionTarget, type AssistantProject, type Scoped } from "./assistant-project-scope.ts";
import { findAiConnection } from "./assistant-db-tools.ts";
import type { ConnectionRow } from "../db.service.ts";
import { dialectFor } from "../database/dialects.ts";
import { assistantSqlSafety, type SqlSafety } from "./assistant-sql-safety.ts";
import { assistantSqlReachSafety, connectionCatalogReader, type CatalogReader } from "./assistant-sql-reach-check.ts";

/**
 * Turns `ui_open_tab`'s `kind` and `target` into what the device opens, checked against what
 * PPM has registered: a chat proven to be the project's, a connection the user left available
 * to the AI, a file the editor's own read rules allow. The device gets only these normalised
 * fields, never the agent's raw input.
 */

const MAX_NAME_CHARS = 200;
const MAX_LINE = 10_000_000;
const SECTION_RE = /^[a-z][a-z-]{0,39}$/;
const PROVIDERS = ["claude", "codex"] as const;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** An optional short name (a table, a schema, a database); null when malformed. */
function optionalName(value: unknown): string | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > MAX_NAME_CHARS || /[\0\r\n]/.test(value)) return null;
  return value;
}

function chatTarget(project: AssistantProject, t: Record<string, unknown>): Scoped<AssistantOpenTabTarget> {
  if (t.sessionId === undefined || t.sessionId === null || t.sessionId === "") {
    if (t.providerId !== undefined && !PROVIDERS.includes(t.providerId as never)) {
      return { ok: false, error: "`target.providerId` must be \"claude\" or \"codex\"." };
    }
    return { ok: true, value: { kind: "chat", ...(t.providerId ? { providerId: t.providerId as "claude" | "codex" } : {}) } };
  }
  const session = resolveAssistantSessionTarget(project, t.sessionId, t.providerId);
  if (!session.ok) return session;
  const { sessionId, providerId } = session.value;
  const design = getSessionDesignSlug(sessionId);
  if (design) {
    return { ok: false, error: `That chat belongs to the design "${design.slice(0, 100)}" and opens with it; ask the user to open the design.` };
  }
  const title = getSessionTitle(sessionId)?.slice(0, 100);
  return { ok: true, value: { kind: "chat", sessionId, providerId, ...(title ? { title } : {}) } };
}

/** Builds the catalog reader a table's read proof asks, on the database the tab will open. */
export type TableCatalogReader = (conn: ConnectionRow, database: string | undefined) => CatalogReader;

const catalogReaderFor: TableCatalogReader = (conn, database) => connectionCatalogReader(conn, database);

/**
 * Whether the first page a table tab loads only reads. The grid runs `SELECT … FROM <table>` as
 * soon as the tab shows, and "table" there is any relation the catalog lists: a view, a
 * materialized view or a foreign table runs its own code on that read, on a read-only connection
 * too (a view over `pg_terminate_backend` closes another session). So the same proof `db_query`
 * gives an unasked read is given to `SELECT * FROM <table>`; what it cannot prove is refused,
 * and the agent can put that read to the user with `db_query`, which asks.
 */
async function tableReadProof(conn: ConnectionRow, table: string, schema: string | undefined, database: string | undefined, reader: TableCatalogReader): Promise<SqlSafety> {
  const dialect = dialectFor(conn.type);
  const sql = `SELECT * FROM ${dialect.qualify(table, schema ?? null)}`;
  const called = new Set<string>();
  const text = assistantSqlSafety(sql, dialect.name, called);
  if (!text.proven) return text;
  return assistantSqlReachSafety(sql, dialect.name, called, reader(conn, database));
}

async function databaseTarget(t: Record<string, unknown>, reader: TableCatalogReader): Promise<Scoped<AssistantOpenTabTarget>> {
  const found = findAiConnection(t.connectionId);
  if (!found.ok) return found;
  const table = optionalName(t.table);
  const schema = optionalName(t.schema);
  const database = optionalName(t.database);
  if (table === null || schema === null || database === null) {
    return { ok: false, error: `\`target.table\`, \`schema\` and \`database\` must be names of at most ${MAX_NAME_CHARS} characters.` };
  }
  const { conn } = found;
  if (table) {
    const proof = await tableReadProof(conn, table, schema, database, reader);
    if (!proof.proven) {
      return {
        ok: false,
        error: `Not opened: a table tab reads "${table}" as soon as it shows, and PPM cannot prove that read has no other effect (${proof.reason}). `
          + "Read it with db_query, which asks the user first, or ask the user to open it themselves.",
      };
    }
    noteAssistantTableOpen({ connectionId: conn.id, database, schema, table });
  }
  return {
    ok: true,
    value: {
      kind: "database", connectionId: conn.id, connectionName: conn.name, dbType: conn.type,
      ...(conn.color ? { color: conn.color } : {}),
      ...(database ? { database } : {}), ...(schema ? { schema } : {}), ...(table ? { table } : {}),
    },
  };
}

async function fileTarget(project: AssistantProject, t: Record<string, unknown>): Promise<Scoped<AssistantOpenTabTarget>> {
  let line: number | undefined;
  if (t.line !== undefined && t.line !== null) {
    if (typeof t.line !== "number" || !Number.isInteger(t.line) || t.line < 1 || t.line > MAX_LINE) {
      return { ok: false, error: "`target.line` must be a line number from 1." };
    }
    line = t.line;
  }
  const resolved = await resolveTabTarget(t.path, { sessionId: "", projectPath: project.path, projectName: project.name });
  if (!resolved.ok) return { ok: false, error: resolved.error.replace("`path`", "`target.path`") };
  const { filePath, projectName } = resolved.target;
  return { ok: true, value: { kind: "file", filePath, projectName, ...(line ? { line } : {}) } };
}

/**
 * Table tabs the Assistant opened whose first page has not loaded yet. The device loads that page
 * through the grid route as the user's browser, which does not audit plain browsing; this is how
 * the route knows the load was the agent's doing and audits it as such
 * (`takeAssistantTableOpen`). One entry per open, used once, gone after a minute.
 */
interface TableOpen {
  connectionId: number;
  database: string | undefined;
  schema: string | undefined;
  table: string;
  expires: number;
}

const TABLE_OPEN_TTL_MS = 60_000;
const MAX_TABLE_OPENS = 100;
const tableOpens: TableOpen[] = [];

function pruneTableOpens(now: number): void {
  for (let i = tableOpens.length - 1; i >= 0; i--) if (tableOpens[i]!.expires <= now) tableOpens.splice(i, 1);
}

function noteAssistantTableOpen(open: Omit<TableOpen, "expires">): void {
  const now = Date.now();
  pruneTableOpens(now);
  if (tableOpens.length >= MAX_TABLE_OPENS) tableOpens.shift();
  tableOpens.push({ ...open, expires: now + TABLE_OPEN_TTL_MS });
}

/**
 * Whether a grid page load of this table is the first one a tab the Assistant opened makes; if
 * so the entry is used up. A schema or database the open did not name matches whatever the tab
 * chose for it, and a load that names no database may be on the connection's own one, which the
 * open may have spelled out — counting it errs towards auditing.
 */
export function takeAssistantTableOpen(load: { connectionId: number; database?: string; schema?: string | null; table: string }): boolean {
  pruneTableOpens(Date.now());
  const i = tableOpens.findIndex((o) => o.connectionId === load.connectionId && o.table === load.table
    && (o.schema === undefined || o.schema === (load.schema ?? undefined))
    && (o.database === undefined || load.database === undefined || o.database === load.database));
  if (i < 0) return false;
  tableOpens.splice(i, 1);
  return true;
}

export async function resolveOpenTabTarget(
  project: AssistantProject,
  kind: unknown,
  rawTarget: unknown,
  reader: TableCatalogReader = catalogReaderFor,
): Promise<Scoped<AssistantOpenTabTarget>> {
  if (!isAssistantTabKind(kind)) return { ok: false, error: `\`kind\` must be one of: ${ASSISTANT_TAB_KINDS.join(", ")}.` };
  if (rawTarget !== undefined && rawTarget !== null && !isObj(rawTarget)) return { ok: false, error: "`target` must be an object." };
  const t = isObj(rawTarget) ? rawTarget : {};
  switch (kind) {
    case "chat": return chatTarget(project, t);
    case "terminal": return { ok: true, value: { kind: "terminal" } };
    case "database": return databaseTarget(t, reader);
    case "file": return fileTarget(project, t);
    case "git": {
      const view = t.view ?? "review";
      if (view !== "review" && view !== "log") return { ok: false, error: "`target.view` must be \"review\" or \"log\"." };
      return { ok: true, value: { kind: "git", view } };
    }
    case "settings": {
      if (t.section === undefined || t.section === null || t.section === "") return { ok: true, value: { kind: "settings" } };
      if (typeof t.section !== "string" || !SECTION_RE.test(t.section)) return { ok: false, error: "`target.section` is not a Settings section id." };
      return { ok: true, value: { kind: "settings", section: t.section } };
    }
  }
}
