import type { MiddlewareHandler } from "hono";
import { SESSIONS_LIST_CHANGED_EVENT, type RenamedChat } from "../../shared/chat-list-events.ts";

/**
 * Tells every open PPM that a project's chat list changed, after a chat-list route that writes
 * answers with a 2xx — whoever called it: a screen, the `ppm` CLI or the Assistant. The event is
 * `sessions:list_changed {projectName}`, which a browser holding that project's list answers by
 * re-syncing it, so a rename, a pin, a tag or a deleted chat shows at once on every device. A
 * refused write (4xx/5xx) changed nothing and announces nothing; a read never announces.
 *
 * A rename also says which chat and what it is called now (`renamed`, set by the route as the
 * `renamedChat` variable): an open tab keeps its own title, so the list alone would leave it on
 * the old one until somebody clicked into it.
 *
 * The announcement goes out through `c.env.announceChatListChanged` when the caller passes one
 * (the CLI running a route in its own process when no server holds the database, where nobody
 * listens; tests), else on `/ws/global`, loaded on first use so the routers stay importable
 * without it.
 */
export const ANNOUNCE_CHAT_LIST_ENV_KEY = "announceChatListChanged";

export { SESSIONS_LIST_CHANGED_EVENT };

/** The route variable a rename sets so the announcement can carry the chat and its new title. */
export const RENAMED_CHAT_VAR = "renamedChat";

export type ChatListEnv = { Variables: { projectName: string; renamedChat?: RenamedChat } };

type Announce = (projectName: string, renamed?: RenamedChat) => void;

const broadcastOnGlobalSocket: Announce = (projectName, renamed) => {
  void import("../ws/global.ts")
    .then(({ broadcastGlobalEvent }) => broadcastGlobalEvent({
      type: SESSIONS_LIST_CHANGED_EVENT, projectName, ...(renamed ? { renamed } : {}),
    }))
    .catch(() => { /* no socket layer in this process: nobody to tell */ });
};

function announcerFor(env: unknown): Announce {
  const own = env && typeof env === "object" ? (env as Record<string, unknown>)[ANNOUNCE_CHAT_LIST_ENV_KEY] : undefined;
  return typeof own === "function" ? (own as Announce) : broadcastOnGlobalSocket;
}

export const announceChatListChanges: MiddlewareHandler<ChatListEnv> = async (c, next) => {
  await next();
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return;
  if (c.res.status < 200 || c.res.status >= 300) return;
  const projectName = c.get("projectName");
  if (projectName) announcerFor(c.env)(projectName, c.get(RENAMED_CHAT_VAR));
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
