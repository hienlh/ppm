import type { MiddlewareHandler } from "hono";

/**
 * Tells every open PPM that a project's chat list changed, after a chat-list route that writes
 * answers with a 2xx — whoever called it: a screen, the `ppm` CLI or the Assistant. The event is
 * `sessions:list_changed {projectName}`, which a browser holding that project's list answers by
 * re-syncing it, so a rename, a pin, a tag or a deleted chat shows at once on every device. A
 * refused write (4xx/5xx) changed nothing and announces nothing; a read never announces.
 *
 * The announcement goes out through `c.env.announceChatListChanged` when the caller passes one
 * (the CLI running a route in its own process when no server holds the database, where nobody
 * listens; tests), else on `/ws/global`, loaded on first use so the routers stay importable
 * without it.
 */
export const ANNOUNCE_CHAT_LIST_ENV_KEY = "announceChatListChanged";

export const SESSIONS_LIST_CHANGED_EVENT = "sessions:list_changed";

type Announce = (projectName: string) => void;

const broadcastOnGlobalSocket: Announce = (projectName) => {
  void import("../ws/global.ts")
    .then(({ broadcastGlobalEvent }) => broadcastGlobalEvent({ type: SESSIONS_LIST_CHANGED_EVENT, projectName }))
    .catch(() => { /* no socket layer in this process: nobody to tell */ });
};

function announcerFor(env: unknown): Announce {
  const own = env && typeof env === "object" ? (env as Record<string, unknown>)[ANNOUNCE_CHAT_LIST_ENV_KEY] : undefined;
  return typeof own === "function" ? (own as Announce) : broadcastOnGlobalSocket;
}

export const announceChatListChanges: MiddlewareHandler<{ Variables: { projectName: string } }> = async (c, next) => {
  await next();
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return;
  if (c.res.status < 200 || c.res.status >= 300) return;
  const projectName = c.get("projectName");
  if (projectName) announcerFor(c.env)(projectName);
};

/**
 * The chat routes that change a project's list: create and bulk delete (`/sessions`), rename,
 * delete and bulk tag (`/sessions/:id`), and a chat's pin, tag, account and fork. Read and
 * unread are not here: they announce `session:unread_changed` themselves.
 */
export const CHAT_LIST_WRITE_PATHS = [
  "/sessions",
  "/sessions/:id",
  "/sessions/:id/pin",
  "/sessions/:id/tag",
  "/sessions/:id/account",
  "/sessions/:id/fork",
] as const;
