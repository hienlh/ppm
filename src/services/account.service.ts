import { randomUUID, createHash, randomBytes } from "node:crypto";
import { encrypt, decrypt } from "../lib/account-crypto.ts";
import {
  getAccounts,
  getAccountById,
  insertAccount,
  updateAccount,
  deleteAccount,
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
  createdAt: number;
}

export interface AccountWithTokens extends Account {
  accessToken: string;
  refreshToken: string;
}

const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_AUTH_URL = "https://claude.ai/oauth/authorize";
const OAUTH_TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const OAUTH_SCOPE = "org:create_api_key user:profile user:inference";

class AccountService {
  private pendingStates = new Map<string, { verifier: string; createdAt: number }>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  private toAccount(row: AccountRow): Account {
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

  add(params: {
    email: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    label?: string;
  }): Account {
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
    });
    return this.toAccount(getAccountById(id)!);
  }

  async verifyToken(token: string): Promise<{
    valid: boolean;
    email?: string;
    orgName?: string;
    subscriptionType?: string;
    authMethod?: string;
  }> {
    const isOAuth = token.startsWith("sk-ant-oat");

    if (isOAuth) {
      // Verify via usage API — 200/429 = valid, 401/403 = invalid
      try {
        const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": "ppm/1.0",
          },
          signal: AbortSignal.timeout(10_000),
        });
        // 200 = valid, 429 = rate limited but valid token
        if (res.status === 200 || res.status === 429) {
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
    const id = randomUUID();
    const email = info.email ?? null;
    // Auto-generate label: orgName (subscription) > authMethod-based > user-provided > fallback
    let label = params.label;
    if (!label) {
      if (info.orgName) {
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
    updateAccount(id, { status: "active", cooldown_until: null });
  }

  remove(id: string): void {
    deleteAccount(id);
  }

  trackUsage(id: string): void {
    incrementAccountRequests(id);
    updateAccount(id, { last_used_at: Math.floor(Date.now() / 1000) });
  }

  // ---------------------------------------------------------------------------
  // OAuth PKCE helpers
  // ---------------------------------------------------------------------------

  private generatePkce(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString("base64url");
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

  async completeOAuthFlow(code: string, state: string, redirectUri: string): Promise<Account> {
    const pending = this.pendingStates.get(state);
    if (!pending) throw new Error("Invalid or expired OAuth state");
    this.pendingStates.delete(state);

    const tokens = await this.exchangeCode(code, pending.verifier, redirectUri);
    return this.add({
      email: tokens.email,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    });
  }

  async exchangeCode(code: string, verifier: string, redirectUri: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    email: string;
  }> {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: OAUTH_CLIENT_ID,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
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

  async refreshAccessToken(accountId: string): Promise<void> {
    const account = this.getWithTokens(accountId);
    if (!account) throw new Error(`Account ${accountId} not found`);
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: OAUTH_CLIENT_ID,
        refresh_token: account.refreshToken,
      }),
    });
    if (!res.ok) {
      this.setDisabled(accountId);
      throw new Error(`Token refresh failed for account ${accountId}: ${res.status}`);
    }
    const data = await res.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
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

  exportEncrypted(): string {
    // Export raw DB rows (tokens are already encrypted) as JSON
    const rows = getAccounts();
    return JSON.stringify(rows, null, 2);
  }

  importEncrypted(json: string): number {
    const rows = JSON.parse(json) as AccountRow[];
    if (!Array.isArray(rows)) throw new Error("Invalid backup format");
    let count = 0;
    for (const row of rows) {
      if (!row.id || !row.access_token || !row.refresh_token) continue;
      // Skip if account already exists
      if (getAccountById(row.id)) continue;
      insertAccount({
        id: row.id,
        label: row.label,
        email: row.email,
        access_token: row.access_token,
        refresh_token: row.refresh_token,
        expires_at: row.expires_at,
        status: row.status ?? "active",
        cooldown_until: row.cooldown_until,
        priority: row.priority ?? 0,
        total_requests: row.total_requests ?? 0,
        last_used_at: row.last_used_at,
      });
      count++;
    }
    return count;
  }

  // ---------------------------------------------------------------------------
  // Auto-refresh background timer
  // ---------------------------------------------------------------------------

  startAutoRefresh(): void {
    if (this.refreshTimer) return;
    const CHECK_INTERVAL_MS = 5 * 60_000;
    const REFRESH_BUFFER_S = 5 * 60;

    this.refreshTimer = setInterval(async () => {
      const accounts = this.list();
      const nowS = Math.floor(Date.now() / 1000);
      for (const acc of accounts) {
        if (acc.status === "disabled") continue;
        if (!acc.expiresAt) continue;
        if (acc.expiresAt - nowS > REFRESH_BUFFER_S) continue;
        console.log(`[accounts] Auto-refreshing token for ${acc.email ?? acc.id}`);
        try {
          await this.refreshAccessToken(acc.id);
        } catch (e) {
          console.error(`[accounts] Auto-refresh failed for ${acc.id}:`, e);
        }
      }
    }, CHECK_INTERVAL_MS);

    if (typeof this.refreshTimer === "object" && this.refreshTimer !== null && "unref" in this.refreshTimer) {
      (this.refreshTimer as NodeJS.Timeout).unref();
    }
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}

export const accountService = new AccountService();
