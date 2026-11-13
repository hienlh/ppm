import type { MiddlewareHandler } from "hono";
import { JIRA_CONFIG_CHANGED_EVENT, JIRA_WATCHERS_CHANGED_EVENT, type JiraChangeEvent } from "../../shared/jira-events.ts";

/**
 * Tells every open PPM that a Jira config or the watchers changed, after a Jira write answers with
 * a 2xx — whoever called it. A refused write changed nothing and announces nothing; a read, a
 * connection test, a JQL dry run and the ticket proxy (which writes to Jira, not to PPM) never
 * announce. Debug runs already have their own `jira:status_change`.
 *
 * The announcement goes out through `c.env.announceJiraChanged` when the caller passes one (the
 * CLI running a route in its own process with no server to tell; tests), else on `/ws/global`,
 * loaded on first use so the router stays importable without it.
 */
export const ANNOUNCE_JIRA_ENV_KEY = "announceJiraChanged";

type Announce = (type: JiraChangeEvent) => void;

const broadcastOnGlobalSocket: Announce = (type) => {
  void import("../ws/global.ts")
    .then(({ broadcastGlobalEvent }) => broadcastGlobalEvent({ type }))
    .catch(() => { /* no socket layer in this process: nobody to tell */ });
};

function announcerFor(env: unknown): Announce {
  const own = env && typeof env === "object" ? (env as Record<string, unknown>)[ANNOUNCE_JIRA_ENV_KEY] : undefined;
  return typeof own === "function" ? (own as Announce) : broadcastOnGlobalSocket;
}

/** Which event a write on `/api/jira<sub>` announces, or null. */
export function jiraEventFor(method: string, sub: string): JiraChangeEvent | null {
  if ((method === "PUT" || method === "DELETE") && /^\/config\/\d+$/.test(sub)) return JIRA_CONFIG_CHANGED_EVENT;
  const watcherWrite = (method === "POST" && /^\/watchers(\/\d+\/pull|\/pull-all)?$/.test(sub))
    || ((method === "PUT" || method === "DELETE") && /^\/watchers\/\d+$/.test(sub))
    || (method === "POST" && sub === "/results/manual")
    || (method === "DELETE" && /^\/results\/\d+$/.test(sub))
    || (method === "PATCH" && /^\/results\/\d+\/read$/.test(sub));
  return watcherWrite ? JIRA_WATCHERS_CHANGED_EVENT : null;
}

export const announceJiraChanges: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.res.status < 200 || c.res.status >= 300) return;
  const sub = c.req.path.replace(/^.*?\/jira(?=\/|$)/, "").replace(/\/+$/, "");
  const event = jiraEventFor(c.req.method, sub);
  if (event) announcerFor(c.env)(event);
};
