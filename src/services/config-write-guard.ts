import { configKeyHasPrefix, isSecretConfigKey } from "./config-secret-keys.ts";
import { coerceConfigValue, getNestedValue, setNestedValue, type ConfigValueType } from "../cli/utils/config-key-path.ts";
import { parseLogLevel, LOG_LEVELS } from "../shared/log-levels.ts";
import { isValidLeftoverIdleMinutes, MAX_LEFTOVER_IDLE_MINUTES } from "../shared/leftover-processes.ts";

/**
 * Which config keys a generic "set one key" may write, and for whom: `ppm config set` and the
 * server's `PUT /api/settings/config-key` both decide here.
 *
 * - secret: tokens and API keys. Never through `config set`, for anyone: typed on a command line
 *   they land in shell history and process lists, and each has a screen of its own.
 * - dedicated: keys whose own route does more than store a value (ntfy drops the stored token
 *   when its server changes; a theme or provider change is broadcast and validated as a whole).
 *   Refused here for everyone, pointing at where to change them.
 * - exposure: what decides who can reach this PPM or what it runs (ports, auth, tunnels, a
 *   provider's command line). A person may set them; a command run from an AI chat may not.
 *   That check is advisory — the chat's shell card is the real control.
 * - allowed: plain preferences.
 * Anything else is not settable this way.
 */
export type ConfigKeyTier = "secret" | "dedicated" | "exposure" | "allowed" | "unknown";

const DEDICATED: readonly { pattern: string; where: string }[] = [
  { pattern: "theme", where: "PPM's Settings → Appearance" },
  { pattern: "ai.providers", where: "PPM's Settings → AI Provider" },
  { pattern: "ntfy", where: "PPM's Settings → Notifications (changing the server there drops the stored token)" },
  { pattern: "telegram", where: "PPM's Settings → Notifications" },
  { pattern: "notifications", where: "PPM's Settings → Notifications" },
  { pattern: "clawbot", where: "PPM's Settings → PPMBot" },
  { pattern: "projects", where: "`ppm projects`" },
];

export const EXPOSURE_CONFIG_KEYS: readonly string[] = [
  "auth", "host", "port", "tunnel", "share_host", "cloud_url", "ntfy", "assistant", "android",
  "ai.providers.*.cli_command", "ai.providers.*.base_url", "ai.providers.*.api_key_env", "ai.providers.*.permission_mode",
  "ai.ppm_tools", "ai.tab_tools",
];

/** Plain preferences, with the type each holds when it is not set yet. */
const ALLOWED: Readonly<Record<string, ConfigValueType>> = {
  log_level: "string",
  device_name: "string",
  "query_audit.retention_days": "number",
  "query_audit.max_size_mb": "number",
  "session_trace.retention_days": "number",
  "session_trace.max_size_mb": "number",
  "ai.default_provider": "string",
  "ai.new_chat_provider_mode": "string",
  "ai.share_provider_context": "boolean",
  "ai.leftover_processes_idle_minutes": "number",
};

export function configKeyTier(key: string): ConfigKeyTier {
  if (isSecretConfigKey(key)) return "secret";
  if (DEDICATED.some((d) => configKeyHasPrefix(key, d.pattern))) return "dedicated";
  if (EXPOSURE_CONFIG_KEYS.some((p) => configKeyHasPrefix(key, p))) return "exposure";
  if (Object.hasOwn(ALLOWED, key)) return "allowed";
  return "unknown";
}

/** Why `key` may not be written by `config set` from this caller, or null. */
export function configWriteRefusal(key: string, caller: { aiChat: boolean }): string | null {
  switch (configKeyTier(key)) {
    case "secret": return `"${key}" is a secret and is never set through \`config set\`: change it in PPM's Settings.`;
    case "dedicated": {
      const d = DEDICATED.find((x) => configKeyHasPrefix(key, x.pattern))!;
      return `"${key}" has its own settings: change it in ${d.where}.`;
    }
    case "exposure":
      return caller.aiChat
        ? `"${key}" decides who can reach this PPM or what it runs, so it is not changed from an AI chat. Give the user the command to run, or ask them to change it in Settings.`
        : null;
    case "allowed": return null;
    default: return `"${key}" cannot be set with \`config set\`.`;
  }
}

/** Per-key checks beyond the type. Returns the value to store, or an error. */
function checkValue(key: string, value: string | number | boolean, current: Record<string, unknown>): { value: string | number | boolean } | { error: string } {
  if (key === "log_level") {
    const level = parseLogLevel(String(value));
    return level === null ? { error: `Unknown log level "${value}". Use one of: ${LOG_LEVELS.join(", ")}` } : { value: level };
  }
  if (key === "ai.new_chat_provider_mode" && value !== "default" && value !== "follow-focus") {
    return { error: "ai.new_chat_provider_mode must be default or follow-focus" };
  }
  if (key === "ai.default_provider") {
    const providers = (getNestedValue(current, "ai.providers") ?? {}) as Record<string, unknown>;
    if (!Object.hasOwn(providers, String(value))) return { error: `ai.default_provider "${value}" is not a configured provider (${Object.keys(providers).join(", ")})` };
  }
  if (key === "ai.leftover_processes_idle_minutes" && !isValidLeftoverIdleMinutes(value)) {
    return { error: `ai.leftover_processes_idle_minutes must be a whole number from 0 to ${MAX_LEFTOVER_IDLE_MINUTES}` };
  }
  if ((key.endsWith(".retention_days") || key.endsWith(".max_size_mb") || key === "port") && (!Number.isInteger(value) || (value as number) < 1)) {
    return { error: `${key} must be a positive whole number` };
  }
  if (key === "port" && (value as number) > 65535) return { error: "port must be at most 65535" };
  return { value };
}

export type PreparedConfigWrite =
  | { ok: true; topKey: string; topValue: unknown; value: string | number | boolean }
  | { ok: false; error: string; status: 400 | 403 | 404 };

/**
 * Everything short of storing it: checks the caller may write `key`, types and checks `raw`, and
 * returns the whole top-level value to store (`configService.set(topKey, topValue)`).
 */
export function prepareConfigWrite(key: string, raw: unknown, current: Record<string, unknown>, caller: { aiChat: boolean }): PreparedConfigWrite {
  const refusal = configWriteRefusal(key, caller);
  if (refusal) return { ok: false, error: refusal, status: 403 };
  const existing = getNestedValue(current, key);
  const declared = ALLOWED[key];
  if (existing === undefined && !declared) return { ok: false, error: `Config key "${key}" not found`, status: 404 };
  const typed = coerceConfigValue(existing, raw, declared);
  if ("error" in typed) return { ok: false, error: `"${key}" ${typed.error}`, status: 400 };
  const checked = checkValue(key, typed.value, current);
  if ("error" in checked) return { ok: false, error: checked.error, status: 400 };
  const topKey = key.split(".")[0]!;
  const top = structuredClone({ [topKey]: current[topKey] }) as Record<string, unknown>;
  setNestedValue(top, key, checked.value);
  return { ok: true, topKey, topValue: top[topKey], value: checked.value };
}
