import { api } from "./api-client";

export interface OAuthProfileData {
  account?: {
    uuid?: string;
    full_name?: string;
    display_name?: string;
    email?: string;
    has_claude_max?: boolean;
    has_claude_pro?: boolean;
    created_at?: string;
  };
  organization?: {
    uuid?: string;
    name?: string;
    organization_type?: string;
    billing_type?: string;
    rate_limit_tier?: string;
    has_extra_usage_enabled?: boolean;
    subscription_status?: string;
    subscription_created_at?: string;
  };
  application?: {
    uuid?: string;
    name?: string;
    slug?: string;
  };
}

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
  profileData: OAuthProfileData | null;
  createdAt: number;
  hasRefreshToken: boolean;
}

export interface VerifyResult {
  valid: boolean;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
  authMethod?: string;
  profileData?: OAuthProfileData;
}

export interface AccountSettings {
  strategy: "round-robin" | "fill-first" | "lowest-usage";
  maxRetry: number;
  activeCount: number;
}

export function getAccounts(): Promise<AccountInfo[]> {
  return api.get<AccountInfo[]>("/api/accounts");
}

export function getActiveAccount(): Promise<AccountInfo | null> {
  return api.get<AccountInfo | null>("/api/accounts/active");
}

export function addAccount(params: { apiKey: string; label?: string }): Promise<AccountInfo> {
  return api.post<AccountInfo>("/api/accounts", params);
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

export interface AccountUsageEntry {
  accountId: string;
  accountLabel: string | null;
  accountStatus: string;
  isOAuth: boolean;
  usage: {
    lastFetchedAt?: string;
    session?: import("../../types/chat").LimitBucket;
    weekly?: import("../../types/chat").LimitBucket;
    weeklyOpus?: import("../../types/chat").LimitBucket;
    weeklySonnet?: import("../../types/chat").LimitBucket;
  };
}

export function verifyAccount(id: string): Promise<VerifyResult> {
  return api.post<VerifyResult>(`/api/accounts/${id}/verify`);
}

export function getOAuthUrl(): Promise<{ url: string; state: string }> {
  return api.get<{ url: string; state: string }>("/api/accounts/oauth/url");
}

export function exchangeOAuthCode(code: string, state: string): Promise<AccountInfo> {
  return api.post<AccountInfo>("/api/accounts/oauth/exchange", { code, state });
}

export function getAllAccountUsages(): Promise<AccountUsageEntry[]> {
  return api.get<AccountUsageEntry[]>("/api/accounts/usage");
}

export function importAccounts(params: { data: string; password: string }): Promise<{ imported: number }> {
  return api.post<{ imported: number }>("/api/accounts/import", params);
}

export interface AIProviderSettings {
  type?: string;
  execution_mode?: string;
  api_key_env?: string;
  base_url?: string;
  model?: string;
  effort?: string;
  max_turns?: number;
  max_budget_usd?: number;
  thinking_budget_tokens?: number;
  permission_mode?: string;
  system_prompt?: string;
}

export interface AISettings {
  default_provider: string;
  providers: Record<string, AIProviderSettings>;
}

export function updateDeviceName(device_name: string): Promise<{ device_name: string }> {
  return api.put<{ device_name: string }>("/api/settings/device-name", { device_name });
}

export function getAISettings(): Promise<AISettings> {
  return api.get<AISettings>("/api/settings/ai");
}

export function updateAISettings(settings: Partial<AISettings>): Promise<AISettings> {
  return api.put<AISettings>("/api/settings/ai", settings);
}
