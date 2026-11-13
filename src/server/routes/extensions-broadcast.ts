import type { MiddlewareHandler } from "hono";
import { EXTENSIONS_CHANGED_EVENT } from "../../shared/extensions-events.ts";

/**
 * Tells every open PPM that the extensions changed, after an extensions write answers with a 2xx —
 * whoever called it: Settings, the `ppm ext` CLI or the Assistant. A browser then reads the list
 * and the contributions again (its palette commands, keybindings and views). A refused write
 * changed nothing and announces nothing; a read never announces.
 *
 * The announcement goes out through `c.env.announceExtensionsChanged` when the caller passes one
 * (the CLI running a route in its own process with no server to tell; tests), else on
 * `/ws/global`, loaded on first use so the router stays importable without it.
 */
export const ANNOUNCE_EXTENSIONS_ENV_KEY = "announceExtensionsChanged";

type Announce = () => void;

const broadcastOnGlobalSocket: Announce = () => {
  void import("../ws/global.ts")
    .then(({ broadcastGlobalEvent }) => broadcastGlobalEvent({ type: EXTENSIONS_CHANGED_EVENT }))
    .catch(() => { /* no socket layer in this process: nobody to tell */ });
};

function announcerFor(env: unknown): Announce {
  const own = env && typeof env === "object" ? (env as Record<string, unknown>)[ANNOUNCE_EXTENSIONS_ENV_KEY] : undefined;
  return typeof own === "function" ? (own as Announce) : broadcastOnGlobalSocket;
}

export const announceExtensionChanges: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return;
  if (c.res.status < 200 || c.res.status >= 300) return;
  announcerFor(c.env)();
};
