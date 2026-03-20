import { api } from "./api-client";

export interface AccountInfo {
  id: string;
  label: string | null;
  email: string | null;
  expiresAt: number | null;
  status: "active" | "cooldown" | "disabled";
  cooldownUntil: number | null;
  priority: number;
  totalRequests: number;
  lastUsedAt: number | null;
  createdAt: number;
}

export interface AccountSettings {
  strategy: "round-robin" | "fill-first";
  maxRetry: number;
  activeCount: number;
}

export function getAccounts(): Promise<AccountInfo[]> {
  return api.get<AccountInfo[]>("/api/accounts");
}

export function deleteAccount(id: string): Promise<void> {
  return api.del(`/api/accounts/${id}`);
}

export function patchAccount(id: string, updates: { status: string }): Promise<AccountInfo | null> {
  return api.patch<AccountInfo | null>(`/api/accounts/${id}`, updates);
}

export function getAccountSettings(): Promise<AccountSettings> {
  return api.get<AccountSettings>("/api/accounts/settings");
}

export function updateAccountSettings(s: Partial<Omit<AccountSettings, "activeCount">>): Promise<AccountSettings> {
  return api.put<AccountSettings>("/api/accounts/settings", s);
}

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
