import { api } from "@/lib/api-client";
import type { AssistantSettingsView } from "../../shared/assistant-settings";
import { rememberAssistantName } from "@/stores/assistant-name-store";

/** Settings → PPM Assistant as the server sends it: every MCP env and header value blanked. */
export interface AssistantSettingsResponse {
  settings: AssistantSettingsView;
  /** Providers that can run an Assistant session. */
  providers: Array<{ id: string; name: string }>;
  limits: { instructionsMaxChars: number; maxServers: number; managerTemplateMaxBytes?: number };
  /** PPM's own template for new manager rules, used while `manager_template` is empty. */
  managerTemplateBuiltIn?: string;
}

/**
 * Keys each saved by a pane of their own (digest, quiet hours and restart news; manager chats;
 * the permission switches, saved the moment they flip). The General pane's Save leaves them
 * out, so a draft it loaded earlier never puts an old value back: the server keeps the stored
 * value of any key a save does not name.
 */
export const KEYS_SAVED_ELSEWHERE = [
  "digest", "quiet_hours", "timezone", "manager_default_mode", "manager_template", "restart_news",
  "auto_readonly_commands", "act_on_own", "permission_mode", "db_write_connections", "settings_tools",
] as const;
type KeySavedElsewhere = (typeof KEYS_SAVED_ELSEWHERE)[number];

/** Every answer carries the persona: the name shown across the app follows it at once. */
function noteName(res: AssistantSettingsResponse): AssistantSettingsResponse {
  rememberAssistantName(res?.settings?.persona?.name);
  return res;
}

export function getAssistantSettings(): Promise<AssistantSettingsResponse> {
  return api.get<AssistantSettingsResponse>("/api/assistant/settings").then(noteName);
}

/** A blank env or header value keeps the saved one. Answers with the stored settings, blanked. */
export function saveAssistantSettings(settings: AssistantSettingsView): Promise<AssistantSettingsResponse> {
  return api.put<AssistantSettingsResponse>("/api/assistant/settings", settings).then(noteName);
}

/** The General pane's save: everything but the keys other sub-panes own. */
export function saveGeneralAssistantSettings(settings: AssistantSettingsView): Promise<AssistantSettingsResponse> {
  const body: Partial<AssistantSettingsView> = { ...settings };
  for (const key of KEYS_SAVED_ELSEWHERE) delete body[key];
  return api.put<AssistantSettingsResponse>("/api/assistant/settings", body).then(noteName);
}

/**
 * Changes only the named keys. The General fields are read first and sent back as stored (a
 * blank env or header value keeps the saved one), because a save that omits them would clear
 * them; every other sub-tab's key is left out, so the server keeps its stored value and two
 * sub-tabs saving at once cannot put each other's old value back.
 */
export async function patchAssistantSettings(
  patch: Partial<Pick<AssistantSettingsView, KeySavedElsewhere>>,
): Promise<AssistantSettingsResponse> {
  const current = await getAssistantSettings();
  const body: Partial<AssistantSettingsView> = { ...current.settings };
  delete body.main_session;
  for (const key of KEYS_SAVED_ELSEWHERE) delete body[key];
  return api.put<AssistantSettingsResponse>("/api/assistant/settings", { ...body, ...patch }).then(noteName);
}

/** The zone this browser runs in, which the digest time and quiet hours are saved in. */
export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}
