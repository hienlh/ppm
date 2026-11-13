import { inAiChat } from "../../services/ai-chat-env.ts";
import { noteDirectWrite, serverRequest, ServerDownError } from "../utils/ppm-server-client.ts";
import { fail } from "./projects-cmd-request.ts";

/**
 * How `ppm db` reaches the connection routes: through the running PPM that holds the database —
 * the routes the connection form calls, so the checks (credential paths, a moved endpoint dropping
 * its saved password) are the server's and every open PPM's Database sidebar updates at once — and,
 * only when no PPM holds the database, through those very routes run inside this process after the
 * direct-write notice.
 */

export interface ListedConnection {
  id: number;
  name: string;
  type: string;
  group_name: string | null;
  color: string | null;
  readonly: number;
  ai_access?: number;
  password_mode?: string;
  logged_in?: boolean;
  server?: string | null;
}

let ranHere = false;

/** `/api/db<sub>` on the server, or on the database routes here when no server holds the database. */
export async function dbRequest<T>(method: string, sub: string, body?: unknown): Promise<T> {
  try {
    return await serverRequest<T>(method, `/db${sub}`, body, { timeoutMs: 60_000 });
  } catch (e) {
    if (!(e instanceof ServerDownError)) throw e;
  }
  // A test writes nothing, so it carries no direct-write notice.
  if (method !== "GET" && !/\/test$/.test(sub)) await noteDirectWrite();
  return runDbRouteHere<T>(method, sub, body);
}

async function runDbRouteHere<T>(method: string, sub: string, body: unknown): Promise<T> {
  ranHere = true;
  const { initAdapters } = await import("../../services/database/init-adapters.ts");
  initAdapters();
  const { databaseRoutes } = await import("../../server/routes/database.ts");
  const { ANNOUNCE_DB_CONNECTIONS_ENV_KEY } = await import("../../server/routes/database-connections-broadcast.ts");
  const init: RequestInit = { method };
  if (method !== "GET") {
    init.body = JSON.stringify(body ?? {});
    init.headers = { "Content-Type": "application/json" };
  }
  // No PPM runs to show the change, so there is nobody to announce it to.
  const res = await databaseRoutes.request(`http://ppm.local${sub}`, init, { [ANNOUNCE_DB_CONNECTIONS_ENV_KEY]: () => {} });
  const json = await res.json().catch(() => null) as { ok?: boolean; data?: T; error?: string } | null;
  if (!json?.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
  return json.data as T;
}

/**
 * A test run in this process opened pools and maybe an SSH tunnel for `id`; they would keep the
 * command from exiting. Nothing to do when the server ran it.
 */
export async function closeOpenedHere(id: number): Promise<void> {
  if (!ranHere) return;
  const { getConnectionById } = await import("../../services/db.service.ts");
  const conn = getConnectionById(id);
  if (!conn) return;
  const { closeConnection } = await import("../../services/database/connection-login.ts");
  await closeConnection(conn).catch(() => { /* exiting anyway */ });
  // A SQLite file stays open on an idle timer, which would hold the command until it fires.
  const { sqliteService, readonlySqliteService } = await import("../../services/sqlite.service.ts");
  sqliteService.closeAll();
  readonlySqliteService.closeAll();
}

/** The saved connection `nameOrId` names, from the list the server (or the routes here) give. */
export async function findConnection(nameOrId: string): Promise<ListedConnection | null> {
  const list = await dbRequest<ListedConnection[]>("GET", "/connections");
  const trimmed = nameOrId.trim();
  if (/^\d+$/.test(trimmed)) {
    const byId = list.find((c) => c.id === Number(trimmed));
    if (byId) return byId;
  }
  return list.find((c) => c.name === trimmed) ?? null;
}

/**
 * The connection `nameOrId` names, or the command fails: when there is none, and when it runs in
 * an AI chat and the user made the connection unavailable to one.
 */
export async function connectionOrFail(nameOrId: string): Promise<ListedConnection> {
  const conn = await findConnection(nameOrId);
  if (!conn) fail(`Connection not found: ${nameOrId}`);
  if (conn.ai_access === 0 && inAiChat()) {
    fail(`Connection "${conn.name}" is not available to the AI chat: "Available to the AI chat" is off in its settings in PPM. `
      + "Ask the user to run this command themselves, or to turn that setting on.");
  }
  return conn;
}
