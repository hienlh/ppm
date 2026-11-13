import type { MiddlewareHandler } from "hono";
import { SETTINGS_CHANGED_EVENT, type SettingsSection } from "../../shared/settings-events.ts";

/**
 * Tells every open PPM that a settings section changed, after a write to one of the routes below
 * answers with a 2xx — whoever called it: a screen, the `ppm` CLI or another device. Registered on
 * `/api/settings/*`, `/api/notifications/*`, `/api/accounts/*` and `/api/codex-accounts/*` ahead
 * of the routers it wraps (`SETTINGS_BROADCAST_MOUNTS`).
 *
 * Only the writes listed in `WRITES` announce, each with its section. Everything else stays quiet
 * on purpose: `PUT /ui-prefs` is written on every sidebar drag and tab switch, a provider probe
 * changes no setting, and an account pick only moves the rotation, so announcing any of them
 * would make every open PPM refetch for nothing. A refused write changed nothing and announces
 * nothing; a read never does.
 *
 * The announcement goes out through `c.env.announceSettingsChanged` when the caller passes one
 * (the CLI running a route in its own process with no server to tell; tests), else on
 * `/ws/global`, loaded on first use so the routers stay importable without it.
 */
export const ANNOUNCE_SETTINGS_ENV_KEY = "announceSettingsChanged";

/** The route prefixes the middleware is registered on (each as `<prefix>/*`). */
export const SETTINGS_BROADCAST_MOUNTS = ["/api/settings", "/api/notifications", "/api/accounts", "/api/codex-accounts"] as const;

type Announce = (section: SettingsSection) => void;

/** Method, full path, and the section a 2xx answer to it changed. */
const WRITES: ReadonlyArray<{ method: string; path: RegExp; section: SettingsSection }> = [
  { method: "PUT", path: /^\/api\/settings\/theme$/, section: "theme" },
  { method: "POST", path: /^\/api\/settings\/themes\/?$/, section: "themes" },
  { method: "PATCH", path: /^\/api\/settings\/themes\/[^/]+$/, section: "themes" },
  { method: "DELETE", path: /^\/api\/settings\/themes\/[^/]+$/, section: "themes" },
  { method: "PUT", path: /^\/api\/settings\/ai$/, section: "ai" },
  { method: "PUT", path: /^\/api\/settings\/keybindings$/, section: "keybindings" },
  { method: "PUT", path: /^\/api\/settings\/proxy$/, section: "proxy" },
  { method: "PUT", path: /^\/api\/settings\/query-audit$/, section: "query-audit" },
  { method: "DELETE", path: /^\/api\/settings\/query-audit\/logs$/, section: "query-audit" },
  { method: "PUT", path: /^\/api\/settings\/session-trace$/, section: "session-trace" },
  { method: "PATCH", path: /^\/api\/settings\/files$/, section: "files" },
  // Notifications: what and when, the ntfy topic, the browsers receiving push.
  { method: "PUT", path: /^\/api\/notifications\/settings$/, section: "notifications" },
  { method: "PUT", path: /^\/api\/notifications\/ntfy$/, section: "notifications" },
  { method: "DELETE", path: /^\/api\/notifications\/ntfy$/, section: "notifications" },
  { method: "POST", path: /^\/api\/notifications\/push\/(subscribe|unsubscribe)$/, section: "notifications" },
  // The notification bot: its token, its chats and its connect link.
  { method: "PUT", path: /^\/api\/settings\/telegram$/, section: "telegram" },
  { method: "POST", path: /^\/api\/notifications\/telegram\/connect$/, section: "telegram" },
  { method: "DELETE", path: /^\/api\/notifications\/telegram\/connect$/, section: "telegram" },
  { method: "DELETE", path: /^\/api\/notifications\/telegram\/chats\/[^/]+$/, section: "telegram" },
  // The Assistant on Telegram, under PPMBot's `clawbot` routes.
  { method: "PUT", path: /^\/api\/settings\/clawbot$/, section: "clawbot" },
  { method: "DELETE", path: /^\/api\/settings\/clawbot\/paired\/[^/]+$/, section: "clawbot" },
  { method: "PUT", path: /^\/api\/settings\/clawbot\/telegram$/, section: "clawbot" },
  { method: "POST", path: /^\/api\/settings\/clawbot\/telegram\/connect$/, section: "clawbot" },
  { method: "DELETE", path: /^\/api\/settings\/clawbot\/telegram\/connect$/, section: "clawbot" },
  // MCP servers (the list's own auto-import on first read is a write inside a read: not announced).
  { method: "POST", path: /^\/api\/settings\/mcp\/?$/, section: "mcp" },
  { method: "POST", path: /^\/api\/settings\/mcp\/import$/, section: "mcp" },
  { method: "PUT", path: /^\/api\/settings\/mcp\/[^/]+$/, section: "mcp" },
  { method: "DELETE", path: /^\/api\/settings\/mcp\/[^/]+$/, section: "mcp" },
  // Claude accounts: rotation settings, a rename or switch, a re-check, an add, a removal.
  { method: "PUT", path: /^\/api\/accounts\/settings$/, section: "accounts" },
  { method: "POST", path: /^\/api\/accounts\/?$/, section: "accounts" },
  { method: "POST", path: /^\/api\/accounts\/(import|oauth\/exchange)$/, section: "accounts" },
  { method: "POST", path: /^\/api\/accounts\/[^/]+\/verify$/, section: "accounts" },
  { method: "PATCH", path: /^\/api\/accounts\/[^/]+$/, section: "accounts" },
  { method: "DELETE", path: /^\/api\/accounts\/[^/]+$/, section: "accounts" },
  // Codex accounts.
  { method: "PUT", path: /^\/api\/codex-accounts\/strategy$/, section: "accounts" },
  { method: "POST", path: /^\/api\/codex-accounts\/(api-key|import)$/, section: "accounts" },
  { method: "PATCH", path: /^\/api\/codex-accounts\/[^/]+$/, section: "accounts" },
  { method: "DELETE", path: /^\/api\/codex-accounts\/[^/]+$/, section: "accounts" },
];

/** The section a write to `fullPath` (`/api/...`) announces, or null when it announces nothing. */
export function settingsSectionOf(method: string, fullPath: string): SettingsSection | null {
  const m = method.toUpperCase();
  return WRITES.find((w) => w.method === m && w.path.test(fullPath))?.section ?? null;
}

/** The section a `config-key` write of `key` changed, for the few keys a settings pane shows. */
export function settingsSectionOfConfigKey(key: string): SettingsSection | null {
  const top = key.split(".")[0];
  if (top === "ai") return "ai";
  if (top === "query_audit") return "query-audit";
  if (top === "session_trace") return "session-trace";
  return null;
}

const broadcastOnGlobalSocket: Announce = (section) => {
  void import("../ws/global.ts")
    .then(({ broadcastGlobalEvent }) => broadcastGlobalEvent({ type: SETTINGS_CHANGED_EVENT, section }))
    .catch(() => { /* no socket layer in this process: nobody to tell */ });
};

/** Announces `section` through the caller's announcer when it passed one, else on `/ws/global`. */
export function announceSettingsSection(env: unknown, section: SettingsSection): void {
  const own = env && typeof env === "object" ? (env as Record<string, unknown>)[ANNOUNCE_SETTINGS_ENV_KEY] : undefined;
  (typeof own === "function" ? (own as Announce) : broadcastOnGlobalSocket)(section);
}

export const announceSettingsChanges: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.res.status < 200 || c.res.status >= 300) return;
  const section = settingsSectionOf(c.req.method, c.req.path);
  if (section) announceSettingsSection(c.env, section);
};
