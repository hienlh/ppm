import { api } from "@/lib/api-client";
import type { AssistantSettingsView } from "../../shared/assistant-settings";

/** Settings → PPM Assistant as the server sends it: every MCP env and header value blanked. */
export interface AssistantSettingsResponse {
  settings: AssistantSettingsView;
  /** Providers that can run an Assistant session. */
  providers: Array<{ id: string; name: string }>;
  limits: { instructionsMaxChars: number; maxServers: number };
}

export function getAssistantSettings(): Promise<AssistantSettingsResponse> {
  return api.get<AssistantSettingsResponse>("/api/assistant/settings");
}

/** A blank env or header value keeps the saved one. Answers with the stored settings, blanked. */
export function saveAssistantSettings(settings: AssistantSettingsView): Promise<AssistantSettingsResponse> {
  return api.put<AssistantSettingsResponse>("/api/assistant/settings", settings);
}
