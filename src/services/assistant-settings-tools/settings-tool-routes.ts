import { allowRoute, type RouteRule } from "../assistant-mcp/assistant-route-rules.ts";

/**
 * The only routes the settings tools may call: the writes the Settings panes make, and the
 * installers. Reads are in-process (`settings-catalog-*.ts`), so no GET is listed. Everything else
 * of these routers — the password, the access token, the vault, account sign-ins and exports, MCP
 * servers, keybindings, UI preferences — is out of reach, and `assistant-route-call.ts` also gates
 * `/api/settings/*` to exactly these paths and `config-key` to the catalog's two keys.
 */
export const SETTINGS_ROUTES: readonly RouteRule[] = [
  allowRoute("PUT", "/api/settings/device-name"),
  allowRoute("PUT", "/api/settings/config-key"),
  allowRoute("PUT", "/api/settings/theme"),
  allowRoute("PUT", "/api/settings/ai"),
  allowRoute("PUT", "/api/settings/session-trace"),
  allowRoute("PUT", "/api/settings/query-audit"),
  allowRoute("PATCH", "/api/settings/files"),
  allowRoute("PUT", "/api/settings/clawbot"),
  allowRoute("PUT", "/api/settings/design"),
  allowRoute("PUT", "/api/notifications/settings"),
  allowRoute("PUT", "/api/speech/voice-settings"),
  allowRoute("PUT", "/api/assistant/settings"),
  allowRoute("PUT", "/api/accounts/settings"),
  allowRoute("POST", "/api/speech/install"),
  allowRoute("POST", "/api/speech/uninstall"),
  allowRoute("POST", "/api/lsp/install"),
  allowRoute("POST", "/api/lsp/uninstall"),
  allowRoute("POST", "/api/db/drivers/:id/install"),
  allowRoute("DELETE", "/api/db/drivers/:id"),
  allowRoute("POST", "/api/remote-desktop/relay/install"),
  allowRoute("POST", "/api/remote-desktop/relay/uninstall"),
];

/** The literal paths among {@link SETTINGS_ROUTES}: everything but the database driver's. */
const LITERAL_PATHS: ReadonlySet<string> = new Set(SETTINGS_ROUTES.map((r) => r.path).filter((p) => !p.includes(":")));

/** A database driver's id as the catalog spells them (`mysql`, `ssh`). */
const DRIVER_ID = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Whether `pathname` is one the settings tools may reach: the internal app's gate in front of
 * these routers. `template` also accepts a rule's `:id` placeholder.
 */
export function isSettingsFamilyPath(pathname: string, template = false): boolean {
  if (LITERAL_PATHS.has(pathname)) return true;
  const s = pathname.split("/");
  if (s[1] !== "api" || s[2] !== "db" || s[3] !== "drivers") return false;
  const id = s[4] ?? "";
  if (!DRIVER_ID.test(id) && !(template && id === ":id")) return false;
  return s.length === 5 || (s.length === 6 && s[5] === "install");
}

/** The only keys `PUT /api/settings/config-key` takes from a tool: the catalog's. */
export const CONFIG_KEY_WRITES: ReadonlySet<string> = new Set(["log_level", "auth.enabled"]);
