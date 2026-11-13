import { EXPOSURE_CONFIG_KEYS } from "../../services/config-write-guard.ts";
import { configKeyHasPrefix, isSecretConfigKey } from "../../services/config-secret-keys.ts";
import { isPpmTool } from "../../shared/ppm-tools.ts";
import { coerceConfigValue, getNestedValue, type ConfigValueType } from "./config-key-path.ts";
import { aiChatRefusalText } from "./ai-chat-refusal.ts";

/**
 * `ppm ai set <key> <value>`: which AI setting `key` names, whether this caller may write it, and
 * the smallest `PUT /api/settings/ai` body that writes only it — the route merges a provider's
 * fields, the tool switches and the session limits one at a time, so nothing else is resent (and
 * nothing redacted in the GET answer is written back).
 *
 * - A provider's API key is a secret: never on a command line, for anyone (Settings → AI Provider).
 * - What decides what PPM runs or who reaches it (a provider's command line, base URL, key variable
 *   and permission mode; the PPM tool switches) is refused from an AI chat. Advisory: the shell
 *   card is the real control.
 */

/** Top-level AI settings, with the type each holds. */
const TOP: Readonly<Record<string, ConfigValueType>> = {
  default_provider: "string",
  new_chat_provider_mode: "string",
  share_provider_context: "boolean",
  tab_tools: "boolean",
  leftover_processes_idle_minutes: "number",
};

/** A provider's own fields, with the type each holds when it is not set yet. */
const PROVIDER_FIELDS: Readonly<Record<string, ConfigValueType>> = {
  model: "string", effort: "string", permission_mode: "string", system_prompt: "string",
  max_turns: "number", max_budget_usd: "number", thinking_budget_tokens: "number",
  agent_teams: "boolean", context_1m: "boolean", inherit_claude_mcp: "boolean",
  cli_command: "string", base_url: "string", api_key_env: "string",
  model_context_window: "number", model_auto_compact_token_limit: "number",
};

export type AiSettingWrite =
  | { ok: true; body: Record<string, unknown>; value: string | number | boolean }
  | { ok: false; error: string };

/** `key` without a leading `ai.`, as `ppm ai set` and `ppm config get ai.…` both spell it. */
export const aiKey = (key: string) => key.replace(/^ai\./, "");

/**
 * AI settings that outlast the chat that would change them: a provider's system prompt reaches
 * every chat started after it, `inherit_claude_mcp` hands every chat the user's own MCP servers,
 * and the session-collaboration limits decide what chats may start other chats. Refused from an
 * AI chat like the exposure keys, and as advisory: the shell card is what really stands in the way.
 */
const AI_CHAT_PERSISTENCE_KEYS: readonly string[] = [
  "ai.providers.*.system_prompt", "ai.providers.*.inherit_claude_mcp", "ai.session_collab",
];

/** Why this caller may not write `key` at all, decided before anything is read; null when it may. */
export function aiSettingRefusal(rawKey: string, caller: { aiChat: boolean }): string | null {
  const key = aiKey(rawKey);
  const full = `ai.${key}`;
  if (isSecretConfigKey(full)) return `"${full}" is a secret and is never set on a command line: set it in PPM's Settings → AI Provider.`;
  if (caller.aiChat && [...EXPOSURE_CONFIG_KEYS, ...AI_CHAT_PERSISTENCE_KEYS].some((p) => configKeyHasPrefix(full, p))) {
    return aiChatRefusalText(`"${full}"`, key.startsWith("providers.") ? "Settings → AI Provider" : "Settings → Tools");
  }
  return null;
}

export function planAiSettingWrite(rawKey: string, raw: string, current: Record<string, unknown>, caller: { aiChat: boolean }): AiSettingWrite {
  const refusal = aiSettingRefusal(rawKey, caller);
  if (refusal) return { ok: false, error: refusal };
  const key = aiKey(rawKey);
  const full = `ai.${key}`;
  const parts = key.split(".");
  const typed = (declared: ConfigValueType | undefined) => {
    const coerced = coerceConfigValue(getNestedValue(current, key), raw, declared);
    return "error" in coerced ? { error: `"${full}" ${coerced.error}` } : coerced;
  };

  if (parts.length === 1 && Object.hasOwn(TOP, key)) {
    const t = typed(TOP[key]);
    return "error" in t ? { ok: false, error: t.error } : { ok: true, body: { [key]: t.value }, value: t.value };
  }
  if (parts.length === 2 && parts[0] === "ppm_tools") {
    if (!isPpmTool(parts[1]!)) return { ok: false, error: `"${parts[1]}" is not one of PPM's tools` };
    const t = typed("boolean");
    return "error" in t ? { ok: false, error: t.error } : { ok: true, body: { ppm_tools: { [parts[1]!]: t.value } }, value: t.value };
  }
  if (parts.length === 2 && parts[0] === "session_collab") {
    const t = typed(undefined);
    return "error" in t ? { ok: false, error: t.error } : { ok: true, body: { session_collab: { [parts[1]!]: t.value } }, value: t.value };
  }
  if (parts.length === 3 && parts[0] === "providers") {
    const [, id, field] = parts as [string, string, string];
    const providers = (current.providers ?? {}) as Record<string, unknown>;
    if (!Object.hasOwn(providers, id)) return { ok: false, error: `No provider "${id}" (configured: ${Object.keys(providers).join(", ")})` };
    if (!Object.hasOwn(PROVIDER_FIELDS, field)) return { ok: false, error: `"${field}" is not a provider setting (${Object.keys(PROVIDER_FIELDS).join(", ")})` };
    const t = typed(PROVIDER_FIELDS[field]);
    return "error" in t ? { ok: false, error: t.error } : { ok: true, body: { providers: { [id]: { [field]: t.value } } }, value: t.value };
  }
  return { ok: false, error: `"${full}" is not an AI setting \`ppm ai set\` changes. See \`ppm ai get\` for the keys.` };
}
