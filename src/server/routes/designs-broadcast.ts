import type { MiddlewareHandler } from "hono";
import { DESIGN_LIST_CHANGED_EVENT } from "../../shared/design-events.ts";
import type { DesignRouteEnv } from "./design-route-helpers.ts";

/**
 * Tells every open PPM that a project's design list changed, after a create, rename, delete or
 * restore answers with a 2xx — whoever called it. A refused write changed nothing and announces
 * nothing; a read never announces, and neither does a write inside a design (a comment, a tweak),
 * which has events of its own.
 *
 * The announcement goes out through `c.env.announceDesignListChanged` when the caller passes one
 * (the CLI running the route in its own process with no server to tell; tests), else on
 * `/ws/global`, loaded on first use so the router stays importable without it.
 */
export const ANNOUNCE_DESIGN_LIST_ENV_KEY = "announceDesignListChanged";

type Announce = (projectName: string) => void;

const broadcastOnGlobalSocket: Announce = (projectName) => {
  void import("../ws/global.ts")
    .then(({ broadcastGlobalEvent }) => broadcastGlobalEvent({ type: DESIGN_LIST_CHANGED_EVENT, projectName }))
    .catch(() => { /* no socket layer in this process: nobody to tell */ });
};

function announcerFor(env: unknown): Announce {
  const own = env && typeof env === "object" ? (env as Record<string, unknown>)[ANNOUNCE_DESIGN_LIST_ENV_KEY] : undefined;
  return typeof own === "function" ? (own as Announce) : broadcastOnGlobalSocket;
}

/**
 * Whether a request under `/designs` changes the list: `POST /designs`, `PATCH` or `DELETE
 * /designs/<slug>`, `POST /designs/<slug>/history/<id>/restore`.
 */
export function changesDesignList(method: string, path: string): boolean {
  const m = /\/designs(?:\/([^/]+)(\/history\/[^/]+\/restore)?)?\/?$/.exec(path);
  if (!m) return false;
  if (!m[1] || m[2]) return method === "POST";
  return method === "PATCH" || method === "DELETE";
}

export const announceDesignListChanges: MiddlewareHandler<DesignRouteEnv> = async (c, next) => {
  await next();
  if (c.res.status < 200 || c.res.status >= 300) return;
  if (!changesDesignList(c.req.method, c.req.path)) return;
  const projectName = c.get("projectName");
  if (projectName) announcerFor(c.env)(projectName);
};
