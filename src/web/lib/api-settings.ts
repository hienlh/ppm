import { api } from "./api-client";

export interface AIProviderSettings {
  type?: string;
  api_key_env?: string;
  model?: string;
  effort?: string;
  max_turns?: number;
  max_budget_usd?: number;
  thinking_budget_tokens?: number;
}

export interface AISettings {
  default_provider: string;
  providers: Record<string, AIProviderSettings>;
}

export function getAISettings(): Promise<AISettings> {
  return api.get<AISettings>("/api/settings/ai");
}

export function updateAISettings(settings: Partial<AISettings>): Promise<AISettings> {
  return api.put<AISettings>("/api/settings/ai", settings);
}
