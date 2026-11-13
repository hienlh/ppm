import type { MiddlewareHandler } from "hono";
import { SETTINGS_CHANGED_EVENT, type SettingsSection } from "../../shared/settings-events.ts";

/**
 * Tells every open PPM that a settings section changed, after a write to one of the routes below
 * answers with a 2xx — whoever called it: a screen, the `ppm` CLI or another device. Registered on
 * `/api/settings/*` ahead of the settings routers.
 *
 * Only the writes listed in `WRITES` announce, each with its section. Everything else under
 * `/api/settings` stays quiet on purpose: `PUT /ui-prefs` is written on every sidebar drag and tab
 * switch, and a provider probe changes no setting, so announcing either would make every open
 * PPM refetch for nothing. A refused write changed nothing and announces nothing; a read never does.
 *
 * The announcement goes out through `c.env.announceSettingsChanged` when the caller passes one
 * (the CLI running a route in its own process with no server to tell; tests), else on
 * `/ws/global`, loaded on first use so the routers stay importable without it.
 */
export const ANNOUNCE_SETTINGS_ENV_KEY = "announceSettingsChanged";

type Announce = (section: SettingsSection) => void;

/** Method, path under `/api/settings`, and the section a 2xx answer to it changed. */
const WRITES: ReadonlyArray<{ method: string; path: RegExp; section: SettingsSection }> = [
  { method: "PUT", path: /^\/theme$/, section: "theme" },
  { method: "POST", path: /^\/themes\/?$/, section: "themes" },
  { method: "PATCH", path: /^\/themes\/[^/]+$/, section: "themes" },
  { method: "DELETE", path: /^\/themes\/[^/]+$/, section: "themes" },
  { method: "PUT", path: /^\/ai$/, section: "ai" },
  { method: "PUT", path: /^\/keybindings$/, section: "keybindings" },
  { method: "PUT", path: /^\/proxy$/, section: "proxy" },
  { method: "PUT", path: /^\/query-audit$/, section: "query-audit" },
  { method: "DELETE", path: /^\/query-audit\/logs$/, section: "query-audit" },
  { method: "PUT", path: /^\/session-trace$/, section: "session-trace" },
  { method: "PATCH", path: /^\/files$/, section: "files" },
];

/** The section a write to `/api/settings<sub>` announces, or null when it announces nothing. */
export function settingsSectionOf(method: string, fullPath: string): SettingsSection | null {
  const match = /^\/api\/settings(\/.*)?$/.exec(fullPath);
  if (!match) return null;
  const sub = match[1] ?? "/";
  return WRITES.find((w) => w.method === method.toUpperCase() && w.path.test(sub))?.section ?? null;
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
