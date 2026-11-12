import type { MiddlewareHandler } from "hono";
import { PROJECTS_CHANGED_EVENT } from "../../shared/projects-events.ts";

/**
 * Tells every open PPM that the registered projects changed, after any project route that writes
 * answers with a 2xx — whoever called it: a screen, the `ppm` CLI or the Assistant. A screen then
 * refetches its list instead of showing a rename, a move or a new colour only after a reload. A
 * refused write (4xx/5xx) changed nothing and announces nothing; a read never announces.
 *
 * The announcement goes out through `c.env.announceProjectsChanged` when the caller passes one
 * (the CLI running a route in its own process when no server holds the database: nobody is
 * listening there, and loading the socket layer would only slow it down; tests), else on
 * `/ws/global`, loaded on first use so this router stays importable without it.
 */
export const ANNOUNCE_PROJECTS_ENV_KEY = "announceProjectsChanged";

type Announce = () => void;

const broadcastOnGlobalSocket: Announce = () => {
  void import("../ws/global.ts")
    .then(({ broadcastGlobalEvent }) => broadcastGlobalEvent({ type: PROJECTS_CHANGED_EVENT }))
    .catch(() => { /* no socket layer in this process: nobody to tell */ });
};

function announcerFor(env: unknown): Announce {
  const own = env && typeof env === "object" ? (env as Record<string, unknown>)[ANNOUNCE_PROJECTS_ENV_KEY] : undefined;
  return typeof own === "function" ? (own as Announce) : broadcastOnGlobalSocket;
}

export const announceProjectChanges: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return;
  if (c.res.status < 200 || c.res.status >= 300) return;
  announcerFor(c.env)();
};
