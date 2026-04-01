import { randomUUID, createHash, randomBytes } from "node:crypto";
import { encrypt, decrypt, encryptWithPassword, decryptWithPassword } from "../lib/account-crypto.ts";
import {
  getAccounts,
  getAccountById,
  insertAccount,
  updateAccount,
  deleteAccount,
  deleteSnapshotsForAccount,
  incrementAccountRequests,
  type AccountRow,
} from "./db.service.ts";

export interface Account {
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
}

export interface AccountWithTokens extends Account {
  accessToken: string;
  refreshToken: string;
}

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

/** Check if a token string looks like our encrypted format "iv:authTag:ciphertext" (all hex) */
function looksEncrypted(value: string): boolean {
  const parts = value.split(":");
  return parts.length === 3 && parts.every((p) => /^[0-9a-f]+$/i.test(p));
}

const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_AUTH_URL = "https://claude.ai/oauth/authorize";
const OAUTH_TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const OAUTH_SCOPE = "org:create_api_key user:profile user:inference";
const OAUTH_PLATFORM_REDIRECT = "https://platform.claude.com/oauth/code/callback";

// Survive Bun --hot reloads: persist timer ref across module re-evaluations
const ACCT_HOT_KEY = "__PPM_ACCT_REFRESH__" as const;
const acctHotState = ((globalThis as any)[ACCT_HOT_KEY] ??= {
  refreshTimer: null as ReturnType<typeof setInterval> | null,
}) as { refreshTimer: ReturnType<typeof setInterval> | null };

class AccountService {
  private pendingStates = new Map<string, { verifier: string; createdAt: number }>();

  private toAccount(row: AccountRow): Account {
    let profileData: OAuthProfileData | null = null;
    if (row.profile_json) {
      try { profileData = JSON.parse(row.profile_json); } catch { /* ignore */ }
    }
    return {
      id: row.id,
      label: row.label,
      email: row.email,
      expiresAt: row.expires_at,
      status: row.status,
      cooldownUntil: row.cooldown_until,
      priority: row.priority,
      totalRequests: row.total_requests,
      lastUsedAt: row.last_used_at,
      profileData,
      createdAt: row.created_at,
    };
  }

  private toAccountWithTokens(row: AccountRow): AccountWithTokens {
    return {
      ...this.toAccount(row),
      accessToken: decrypt(row.access_token),
      refreshToken: decrypt(row.refresh_token),
    };
  }

  list(): Account[] {
    return getAccounts().map((r) => this.toAccount(r));
  }

  getWithTokens(id: string): AccountWithTokens | null {
    const row = getAccountById(id);
    if (!row) return null;
    try {
      return this.toAccountWithTokens(row);
    } catch (e) {
      console.error(`[accounts] Failed to decrypt tokens for ${row.label ?? id}:`, (e as Error).message);
      return null;
    }
  }

  /**
   * Ensure the access token for an OAuth account is still fresh.
   * If it's expired or about to expire (within 60s), refresh it proactively.
   * Returns the refreshed account with fresh tokens, or null if refresh failed.
   */
  async ensureFreshToken(id: string): Promise<AccountWithTokens | null> {
    const acc = this.getWithTokens(id);
    if (!acc) return null;
    // Only OAuth tokens need refresh
    if (!acc.accessToken.startsWith("sk-ant-oat")) return acc;
    if (!acc.expiresAt) return acc;
    const nowS = Math.floor(Date.now() / 1000);
    if (acc.expiresAt - nowS > 60) return acc; // still fresh
    try {
      console.log(`[accounts] Pre-flight refresh for ${acc.email ?? id} (expires in ${acc.expiresAt - nowS}s)`);
      await this.refreshAccessToken(id, false);
      return this.getWithTokens(id);
    } catch (e) {
      console.error(`[accounts] Pre-flight refresh failed for ${id}:`, e);
      return null;
    }
  }

  /** Find existing account by email or profile UUID */
  private findDuplicate(email?: string | null, profileData?: OAuthProfileData | null): Account | null {
    if (!email && !profileData?.account?.uuid) return null;
    const existing = this.list();
    for (const acc of existing) {
      // Match by account UUID (most reliable)
      if (profileData?.account?.uuid && acc.profileData?.account?.uuid === profileData.account.uuid) {
        return acc;
      }
      // Match by email
      if (email && acc.email && acc.email === email) {
        return acc;
      }
    }
    return null;
  }

  add(params: {
    email: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    label?: string;
    profileData?: OAuthProfileData;
  }): Account {
    // Check for duplicate — update existing account tokens instead of creating new
    const dup = this.findDuplicate(params.email, params.profileData);
    if (dup) {
      this.updateTokens(dup.id, params.accessToken, params.refreshToken, params.expiresAt);
      if (params.profileData) {
        updateAccount(dup.id, { profile_json: JSON.stringify(params.profileData) });
      }
      if (params.label) updateAccount(dup.id, { label: params.label });
      if (params.email) updateAccount(dup.id, { email: params.email });
      return this.toAccount(getAccountById(dup.id)!);
    }

    const id = randomUUID();
    insertAccount({
      id,
      label: params.label ?? null,
      email: params.email,
      access_token: encrypt(params.accessToken),
      refresh_token: encrypt(params.refreshToken),
      expires_at: params.expiresAt,
      status: "active",
      cooldown_until: null,
      priority: 0,
      total_requests: 0,
      last_used_at: null,
      profile_json: params.profileData ? JSON.stringify(params.profileData) : null,
    });
    return this.toAccount(getAccountById(id)!);
  }

  async verifyToken(token: string): Promise<{
    valid: boolean;
    email?: string;
    orgName?: string;
    subscriptionType?: string;
    authMethod?: string;
    profileData?: OAuthProfileData;
  }> {
    const isOAuth = token.startsWith("sk-ant-oat");

    if (isOAuth) {
      // Verify via profile API — returns email, org, subscription info
      try {
        const res = await fetch("https://api.anthropic.com/api/oauth/profile", {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": "ppm/1.0",
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 200) {
          const data = await res.json() as OAuthProfileData;
          return {
            valid: true,
            authMethod: "oauth_token",
            email: data.account?.email,
            orgName: data.organization?.name,
            subscriptionType: data.organization?.organization_type,
            profileData: data,
          };
        }
        // 429 = rate limited but valid token (no profile data available)
        if (res.status === 429) {
          return { valid: true, authMethod: "oauth_token" };
        }
        return { valid: false };
      } catch {
        return { valid: false };
      }
    }

    // API key: verify via claude auth status
    try {
      const proc = Bun.spawn(["claude", "auth", "status"], {
        env: { ...process.env, ANTHROPIC_API_KEY: token, CLAUDE_CODE_OAUTH_TOKEN: "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      const info = JSON.parse(stdout) as {
        loggedIn?: boolean;
        email?: string;
        orgName?: string;
        subscriptionType?: string;
        authMethod?: string;
      };
      if (!info.loggedIn) return { valid: false };
      return {
        valid: true,
        email: info.email,
        orgName: info.orgName,
        subscriptionType: info.subscriptionType,
        authMethod: info.authMethod ?? "api_key",
      };
    } catch {
      return { valid: false };
    }
  }

  async addManual(params: { apiKey: string; label: string | null }): Promise<Account> {
    const info = await this.verifyToken(params.apiKey);
    if (!info.valid) throw new Error("Invalid token — could not authenticate");

    const email = info.email ?? null;
    // Check for duplicate — update tokens on existing account
    const dup = this.findDuplicate(email, info.profileData);
    if (dup) {
      updateAccount(dup.id, { access_token: encrypt(params.apiKey), status: "active", cooldown_until: null });
      if (info.profileData) updateAccount(dup.id, { profile_json: JSON.stringify(info.profileData) });
      if (email) updateAccount(dup.id, { email });
      return this.toAccount(getAccountById(dup.id)!);
    }

    const id = randomUUID();
    // Auto-generate label: display_name > orgName (subscription) > authMethod-based > user-provided > fallback
    let label = params.label;
    if (!label) {
      const displayName = info.profileData?.account?.display_name || info.profileData?.account?.full_name;
      if (displayName) {
        const orgName = info.profileData?.organization?.name;
        label = orgName ? `${displayName} (${orgName})` : displayName;
      } else if (info.orgName) {
        label = `${info.orgName}${info.subscriptionType ? ` (${info.subscriptionType})` : ""}`;
      } else if (info.authMethod === "oauth_token") {
        label = `Claude Pro/Max`;
      } else if (info.authMethod === "api_key" || params.apiKey.startsWith("sk-ant-api")) {
        label = "API Key";
      } else {
        label = `Account ${this.list().length + 1}`;
      }
    }
    insertAccount({
      id,
      label,
      email,
      access_token: encrypt(params.apiKey),
      refresh_token: encrypt(""),
      expires_at: null,
      status: "active",
      cooldown_until: null,
      priority: 0,
      total_requests: 0,
      last_used_at: null,
      profile_json: info.profileData ? JSON.stringify(info.profileData) : null,
    });
    return this.toAccount(getAccountById(id)!);
  }

  updateTokens(id: string, accessToken: string, refreshToken: string, expiresAt: number): void {
    updateAccount(id, {
      access_token: encrypt(accessToken),
      refresh_token: encrypt(refreshToken),
      expires_at: expiresAt,
      status: "active",
      cooldown_until: null,
    });
  }

  setCooldown(id: string, untilMs: number): void {
    updateAccount(id, {
      status: "cooldown",
      cooldown_until: Math.floor(untilMs / 1000),
    });
  }

  setDisabled(id: string): void {
    updateAccount(id, { status: "disabled" });
  }

  setEnabled(id: string): void {
    // Block re-enabling temporary (no refresh token) or expired-refresh-token accounts
    if (!this.hasRefreshToken(id)) {
      const acc = this.list().find((a) => a.id === id);
      const nowS = Math.floor(Date.now() / 1000);
      if (acc?.expiresAt && acc.expiresAt < nowS) {
        throw new Error("Cannot re-enable expired temporary account. Please login again or import a fresh backup.");
      }
    }
    updateAccount(id, { status: "active", cooldown_until: null });
  }

  remove(id: string): void {
    deleteSnapshotsForAccount(id);
    deleteAccount(id);
  }

  trackUsage(id: string): void {
    incrementAccountRequests(id);
    updateAccount(id, { last_used_at: Math.floor(Date.now() / 1000) });
  }

  // ---------------------------------------------------------------------------
  // OAuth profile
  // ---------------------------------------------------------------------------

  async fetchOAuthProfile(token: string): Promise<OAuthProfileData | undefined> {
    try {
      const res = await fetch("https://api.anthropic.com/api/oauth/profile", {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": "ppm/1.0",
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 200) return await res.json() as OAuthProfileData;
    } catch {
      // Profile fetch is best-effort
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // OAuth PKCE helpers
  // ---------------------------------------------------------------------------

  private generatePkce(): { verifier: string; challenge: string } {
    const verifier = randomBytes(96).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
  }

  private cleanExpiredStates(): void {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [state, val] of this.pendingStates) {
      if (val.createdAt < cutoff) this.pendingStates.delete(state);
    }
  }

  startOAuthFlow(redirectUri: string): string {
    this.cleanExpiredStates();
    const { verifier, challenge } = this.generatePkce();
    const state = randomBytes(16).toString("hex");
    this.pendingStates.set(state, { verifier, createdAt: Date.now() });

    const params = new URLSearchParams({
      response_type: "code",
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: OAUTH_SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return `${OAUTH_AUTH_URL}?${params}`;
  }

  /** Generate OAuth URL using platform.claude.com callback (user copies code manually) */
  startOAuthCodeFlow(): { url: string; state: string } {
    this.cleanExpiredStates();
    const { verifier, challenge } = this.generatePkce();
    const state = randomBytes(16).toString("hex");
    this.pendingStates.set(state, { verifier, createdAt: Date.now() });

    const params = new URLSearchParams({
      response_type: "code",
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: OAUTH_PLATFORM_REDIRECT,
      scope: OAUTH_SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      code: "true",
    });
    return { url: `${OAUTH_AUTH_URL}?${params}`, state };
  }

  /** Exchange code from platform.claude.com callback */
  async completeOAuthCodeFlow(code: string, state: string): Promise<Account> {
    const pending = this.pendingStates.get(state);
    if (!pending) throw new Error("Invalid or expired OAuth state");
    this.pendingStates.delete(state);

    const tokens = await this.exchangeCode(code, pending.verifier, OAUTH_PLATFORM_REDIRECT, state);
    const profileData = await this.fetchOAuthProfile(tokens.accessToken);
    const displayName = profileData?.account?.display_name || profileData?.account?.full_name;
    const orgName = profileData?.organization?.name;
    const label = displayName ? (orgName ? `${displayName} (${orgName})` : displayName) : undefined;
    return this.add({
      email: profileData?.account?.email ?? tokens.email,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      label,
      profileData,
    });
  }

  async completeOAuthFlow(code: string, state: string, redirectUri: string): Promise<Account> {
    const pending = this.pendingStates.get(state);
    if (!pending) throw new Error("Invalid or expired OAuth state");
    this.pendingStates.delete(state);

    const tokens = await this.exchangeCode(code, pending.verifier, redirectUri);
    // Fetch profile data with the new token
    const profileData = await this.fetchOAuthProfile(tokens.accessToken);
    return this.add({
      email: profileData?.account?.email ?? tokens.email,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      profileData,
    });
  }

  async exchangeCode(code: string, verifier: string, redirectUri: string, state?: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    email: string;
  }> {
    const body: Record<string, string> = {
      grant_type: "authorization_code",
      client_id: OAUTH_CLIENT_ID,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    };
    if (state) body.state = state;
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OAuth token exchange failed: ${res.status} ${text}`);
    }
    const data = await res.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      account?: { email_address?: string };
    };
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
      email: data.account?.email_address ?? "",
    };
  }

  /**
   * Refresh an OAuth access token using the stored refresh token.
   * @param disableOnFail - if true, disable the account when refresh fails (default: true).
   *   Background/startup refresh should pass false to avoid disabling accounts prematurely.
   */
  async refreshAccessToken(accountId: string, disableOnFail = true): Promise<void> {
    const account = this.getWithTokens(accountId);
    if (!account) throw new Error(`Account ${accountId} not found`);
    // Skip refresh for temporary accounts (no refresh token)
    if (!account.refreshToken || account.refreshToken === "") {
      throw new Error(`Account ${accountId} has no refresh token (temporary account)`);
    }
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: OAUTH_CLIENT_ID,
        refresh_token: account.refreshToken,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const errorBody = await res.text().catch(() => "");
      console.error(`[accounts] Refresh failed for ${accountId}: ${res.status} ${errorBody}`);
      // invalid_grant or invalid_request = refresh token permanently dead → clear it so account becomes temporary
      if (errorBody.includes("invalid_grant") || errorBody.includes("invalid_request")) {
        console.log(`[accounts] Clearing invalid refresh token for ${account.email ?? accountId} — account is now temporary`);
        updateAccount(accountId, { refresh_token: encrypt("") });
      }
      if (disableOnFail) {
        this.setDisabled(accountId);
      }
      throw new Error(`Token refresh failed for account ${accountId}: ${res.status} ${errorBody}`);
    }
    const data = await res.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    console.log(`[accounts] Token refreshed for ${account.email ?? accountId} (expires_in=${data.expires_in}s, new_refresh=${!!data.refresh_token})`);
    this.updateTokens(
      accountId,
      data.access_token,
      data.refresh_token ?? account.refreshToken,
      Math.floor(Date.now() / 1000) + data.expires_in,
    );
  }

  // ---------------------------------------------------------------------------
  // Export / Import encrypted backup
  // ---------------------------------------------------------------------------

  /** Refresh all OAuth tokens before export so the exported access tokens are fresh (~1h). */
  async refreshBeforeExport(accountIds?: string[]): Promise<void> {
    const accounts = accountIds?.length
      ? accountIds.map((id) => this.getWithTokens(id)).filter(Boolean) as AccountWithTokens[]
      : this.list().map((a) => this.getWithTokens(a.id)).filter(Boolean) as AccountWithTokens[];
    for (const acc of accounts) {
      if (!acc.accessToken.startsWith("sk-ant-oat")) continue;
      if (!acc.expiresAt) continue;
      try {
        await this.refreshAccessToken(acc.id, false);
      } catch {
        // Best-effort — skip accounts whose refresh token is already invalid
      }
    }
  }

  /**
   * Export accounts backup.
   * @param includeRefreshToken - if true, includes refresh tokens (full transfer).
   *   Source keeps its refresh token; it will be auto-cleared if it becomes invalid.
   *   Default false = temporary export (access-only, ~1h).
   */
  exportEncrypted(password: string, accountIds?: string[], includeRefreshToken = false): string {
    const rows = accountIds?.length
      ? accountIds.map((id) => getAccountById(id)).filter(Boolean) as AccountRow[]
      : getAccounts();
    const portable = rows.map((row) => {
      let accessToken = row.access_token;
      try { accessToken = decrypt(accessToken); } catch { /* already plaintext or corrupt */ }
      if (includeRefreshToken) {
        let refreshToken = row.refresh_token;
        try { refreshToken = decrypt(refreshToken); } catch { /* already plaintext or corrupt */ }
        return { ...row, access_token: accessToken, refresh_token: refreshToken };
      }
      return { ...row, access_token: accessToken, refresh_token: "" };
    });
    return encryptWithPassword(JSON.stringify(portable), password);
  }

  /**
   * Import accounts from encrypted backup.
   * Accounts without refresh_token are imported as temporary (access-only, ~1h lifetime).
   * Accounts WITH refresh_token are refreshed immediately to claim ownership
   * (source machine's tokens will be invalidated by Anthropic's rotation).
   */
  async importEncrypted(blob: string, password: string): Promise<{ imported: number; refreshed: number }> {
    const plaintext = decryptWithPassword(blob, password);
    const rows = JSON.parse(plaintext) as AccountRow[];
    if (!Array.isArray(rows)) throw new Error("Invalid backup format");
    let imported = 0;
    const fullTransferIds: string[] = [];
    for (const row of rows) {
      if (!row.id || !row.access_token) continue;
      const hasRefresh = !!row.refresh_token && row.refresh_token !== "";

      // Duplicate handling: update existing account tokens from import
      const existingById = getAccountById(row.id);
      const existingByEmail = row.email ? this.list().find((a) => a.email === row.email) : null;
      const existing = existingById ?? (existingByEmail ? getAccountById(existingByEmail.id) : null);
      if (existing) {
        if (hasRefresh) {
          // Always update tokens when import has refresh token (handles expired/invalid tokens too)
          let accessToken = row.access_token;
          if (!looksEncrypted(accessToken)) accessToken = encrypt(accessToken);
          const refreshToken = looksEncrypted(row.refresh_token) ? row.refresh_token : encrypt(row.refresh_token);
          updateAccount(existing.id, {
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_at: row.expires_at,
            status: "active",
          });
          imported++;
          fullTransferIds.push(existing.id);
          console.log(`[accounts] Updated ${row.email ?? existing.id} tokens from import`);
        }
        continue; // skip if import doesn't have refresh token
      }

      // New account — insert
      let accessToken = row.access_token;
      if (!looksEncrypted(accessToken)) accessToken = encrypt(accessToken);
      const refreshToken = hasRefresh ? (looksEncrypted(row.refresh_token) ? row.refresh_token : encrypt(row.refresh_token)) : encrypt("");
      insertAccount({
        id: row.id,
        label: row.label,
        email: row.email,
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: row.expires_at,
        status: row.status ?? "active",
        cooldown_until: row.cooldown_until,
        priority: row.priority ?? 0,
        total_requests: row.total_requests ?? 0,
        last_used_at: row.last_used_at,
        profile_json: row.profile_json ?? null,
      });
      imported++;
      if (hasRefresh) fullTransferIds.push(row.id);
    }

    // Immediately refresh full-transfer accounts to claim ownership
    let refreshed = 0;
    for (const id of fullTransferIds) {
      try {
        await this.refreshAccessToken(id, false);
        refreshed++;
        console.log(`[accounts] Post-import refresh OK for ${id} — this machine now owns the token`);
      } catch (e) {
        console.warn(`[accounts] Post-import refresh failed for ${id}:`, e);
      }
    }
    return { imported, refreshed };
  }

  /** Check if an account has a valid refresh token (non-empty). */
  hasRefreshToken(id: string): boolean {
    const acc = this.getWithTokens(id);
    if (!acc) return false;
    return acc.refreshToken.length > 0 && acc.refreshToken !== "";
  }

  // ---------------------------------------------------------------------------
  // Auto-refresh background timer
  // ---------------------------------------------------------------------------

  startAutoRefresh(): void {
    if (acctHotState.refreshTimer) return;
    const CHECK_INTERVAL_MS = 5 * 60_000;
    const REFRESH_BUFFER_S = 5 * 60;

    const refreshExpiring = async () => {
      const accounts = this.list();
      const nowS = Math.floor(Date.now() / 1000);
      for (const acc of accounts) {
        if (acc.status === "disabled") continue;
        if (!acc.expiresAt) continue;
        if (acc.expiresAt - nowS > REFRESH_BUFFER_S) continue;
        console.log(`[accounts] Auto-refreshing token for ${acc.email ?? acc.id}`);
        try {
          await this.refreshAccessToken(acc.id, false);
        } catch (e) {
          console.error(`[accounts] Auto-refresh failed for ${acc.id}:`, e);
        }
      }
    };

    // Cleanup: auto-delete expired temporary accounts (no refresh token) after 7 days
    const TEMP_EXPIRY_DAYS = 7;
    const cleanupExpiredTemporary = () => {
      const nowS = Math.floor(Date.now() / 1000);
      const accounts = this.list();
      for (const acc of accounts) {
        if (!acc.expiresAt) continue;
        // Only cleanup accounts without refresh token
        if (this.hasRefreshToken(acc.id)) continue;
        const expiredForS = nowS - acc.expiresAt;
        if (expiredForS > TEMP_EXPIRY_DAYS * 86400) {
          console.log(`[accounts] Auto-deleting expired temporary account ${acc.email ?? acc.id} (expired ${Math.floor(expiredForS / 86400)}d ago)`);
          this.remove(acc.id);
        }
      }
    };

    // Run immediately on startup, then every 5 minutes
    refreshExpiring().catch(() => {});
    cleanupExpiredTemporary();
    acctHotState.refreshTimer = setInterval(() => {
      refreshExpiring().catch(() => {});
      cleanupExpiredTemporary();
    }, CHECK_INTERVAL_MS);

    if (typeof acctHotState.refreshTimer === "object" && acctHotState.refreshTimer !== null && "unref" in acctHotState.refreshTimer) {
      (acctHotState.refreshTimer as NodeJS.Timeout).unref();
    }
  }

  stopAutoRefresh(): void {
    if (acctHotState.refreshTimer) {
      clearInterval(acctHotState.refreshTimer);
      acctHotState.refreshTimer = null;
    }
  }
}

export const accountService = new AccountService();
