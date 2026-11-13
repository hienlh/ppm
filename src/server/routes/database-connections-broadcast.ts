import type { MiddlewareHandler } from "hono";
import { DB_CONNECTIONS_CHANGED_EVENT } from "../../shared/db-connection-events.ts";

/**
 * Tells every open PPM that the saved database connections changed, after a connection write
 * answers with a 2xx — whoever called it: a screen, the `ppm` CLI or the Assistant. The Database
 * sidebar then reads its list again instead of showing the change only after a reload. A refused
 * write changed nothing and announces nothing; a read never announces.
 *
 * Registered on `/connections`, `/connections/:id` and `/connections/:id/duplicate` of the database
 * router. The writes there are create, edit, delete, import and folder (both POSTs on
 * `/connections/:id`, where `:id` is the literal `import` or `folder`) and duplicate; the data
 * routes below a connection (`/query`, `/cell`, `/login`…) are not matched.
 *
 * The announcement goes out through `c.env.announceDbConnectionsChanged` when the caller passes one
 * (the CLI running the route in its own process with no server to tell; tests), else on
 * `/ws/global`, loaded on first use.
 */
export const ANNOUNCE_DB_CONNECTIONS_ENV_KEY = "announceDbConnectionsChanged";

type Announce = () => void;

const broadcastOnGlobalSocket: Announce = () => {
  void import("../ws/global.ts")
    .then(({ broadcastGlobalEvent }) => broadcastGlobalEvent({ type: DB_CONNECTIONS_CHANGED_EVENT }))
    .catch(() => { /* no socket layer in this process: nobody to tell */ });
};

function announcerFor(env: unknown): Announce {
  const own = env && typeof env === "object" ? (env as Record<string, unknown>)[ANNOUNCE_DB_CONNECTIONS_ENV_KEY] : undefined;
  return typeof own === "function" ? (own as Announce) : broadcastOnGlobalSocket;
}

export const announceDbConnectionChanges: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return;
  if (c.res.status < 200 || c.res.status >= 300) return;
  announcerFor(c.env)();
};

/** The router paths the announcement is registered on. */
export const DB_CONNECTION_WRITE_PATHS = ["/connections", "/connections/:id", "/connections/:id/duplicate"] as const;
