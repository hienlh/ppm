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
  /** When the current OAuth grant was issued. Null for rows that predate the column. */
  grantedAt: number | null;
  /** Refresh-token expiry as reported by the token endpoint, when it reports one. */
  refreshExpiresAt: number | null;
  /** The OAuth server rejected the refresh token; nothing but a fresh sign-in clears it. */
  reauthRequired: boolean;
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

/**
 * Anthropic invalidates the entire refresh-token family this long after the original
 * grant, whether or not the token kept rotating in between. Measured twice on a live
 * install: developers@ signed in 2026-08-11 and was rejected 2026-09-08 (28d 2h);
 * victor@ signed in 2026-08-18 and was rejected 2026-09-15 (27d 15h). Both died on the
 * first use of a token minted hours earlier, so this is grant age, not token age.
 *
 * Only a fallback: if the token endpoint reports the refresh token's own expiry we use
 * that instead, because a guessed constant silently rots if Anthropic changes it.
 */
const GRANT_LIFETIME_S = 28 * 86400;

/**
 * How close to expiry a token may be before use forces a refresh. Claude Code uses
 * 5 minutes (`g0e = 300000` in its bundle) and refreshes at the point of use rather
 * than on a timer; PPM now does the same.
 *
 * A buffer this small can hand a long turn a token that lapses mid-run. That is
 * survivable here, and only here, because the 401 path in claude-agent-sdk.ts force-
 * refreshes and retries the turn instead of failing it. Shrink that safety net and this
 * number has to grow again.
 */
const PREFLIGHT_REFRESH_BUFFER_S = 300;

/** Response fields we already understand; anything else is worth learning about. */
const KNOWN_TOKEN_FIELDS = new Set([
  "access_token", "refresh_token", "expires_in", "token_type", "scope", "account", "organization",
  "refresh_token_expires_in", "refresh_expires_in", "refresh_token_expires_at", "refresh_expires_at",
]);
const loggedUnknownTokenFields = new Set<string>();

/**
 * Log response fields we do not consume, once per field name.
 *
 * The refresh-token expiry is the one number that would let PPM warn before a grant
 * dies, and Claude Code stores it (`claudeAiOauth.refreshTokenExpiresAt`), but its own
 * wire format is not public. Rather than hard-code a guess, read whichever field shows
 * up and surface the rest so an unknown name is a log line instead of a silent miss.
 */
function noteUnknownTokenFields(data: Record<string, unknown>, context: string): void {
  for (const key of Object.keys(data)) {
    if (KNOWN_TOKEN_FIELDS.has(key) || loggedUnknownTokenFields.has(key)) continue;
    loggedUnknownTokenFields.add(key);
    const value = data[key];
    const shown = typeof value === "string" && /token|secret|key/i.test(key)
      ? `<redacted len=${value.length}>`
      : JSON.stringify(value);
    console.log(`[accounts] ${context} response carries unhandled field "${key}" = ${shown}`);
  }
}

/** Pull the refresh token's own expiry out of a token response, in whatever shape it arrives. */
function readRefreshExpiry(data: Record<string, unknown>): number | null {
  const nowS = Math.floor(Date.now() / 1000);
  for (const key of ["refresh_token_expires_in", "refresh_expires_in"]) {
    const v = data[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return nowS + Math.floor(v);
  }
  for (const key of ["refresh_token_expires_at", "refresh_expires_at"]) {
    const v = data[key];
    // Milliseconds if it is far past any plausible epoch-seconds value.
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v > 1e11 ? Math.floor(v / 1000) : Math.floor(v);
  }
  return null;
}

// Survive Bun --hot reloads: persist timer ref across module re-evaluations
const ACCT_HOT_KEY = "__PPM_ACCT_REFRESH__" as const;
const acctHotState = ((globalThis as any)[ACCT_HOT_KEY] ??= {
  refreshTimer: null as ReturnType<typeof setInterval> | null,
}) as { refreshTimer: ReturnType<typeof setInterval> | null };

class AccountService {
  private pendingStates = new Map<string, { verifier: string; createdAt: number }>();
  /** Per-account mutex: dedup concurrent refresh calls so only one OAuth request fires at a time. */
  private pendingRefreshes = new Map<string, Promise<void>>();

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
      grantedAt: row.granted_at,
      refreshExpiresAt: row.refresh_expires_at,
      reauthRequired: row.reauth_required === 1,
    };
  }

  /**
   * When this account's refresh token family is expected to die, or null if unknowable.
   *
   * Prefers whatever the server reported. Falls back to grant age, which is only
   * available for accounts signed in since PPM started recording it — an older row
   * reads as "unknown" rather than being given a fabricated date.
   */
  grantExpiresAt(acc: Account): number | null {
    if (acc.refreshExpiresAt) return acc.refreshExpiresAt;
    if (acc.grantedAt) return acc.grantedAt + GRANT_LIFETIME_S;
    return null;
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
   * If it's expired or about to expire (within 1 hour), refresh it proactively.
   * The generous buffer prevents 401 errors mid-conversation — the SDK subprocess
   * may run for a long time before the token is actually sent to the API.
   * Returns the refreshed account with fresh tokens, or null if refresh failed.
   */
  async ensureFreshToken(id: string): Promise<AccountWithTokens | null> {
    return (await this.ensureFreshTokenChecked(id)).account;
  }

  /**
   * `ensureFreshToken`, keeping the reason it failed.
   *
   * `rejected` means the OAuth server turned the refresh token itself down (`invalid_grant`
   * / `invalid_request`): nothing local recovers from that, only a fresh sign-in. Anything
   * else — a network drop, a 429, a decrypt failure — is transient and worth retrying,
   * which is a different sentence to put in front of a user. `ensureFreshToken` collapses
   * the two because its callers are background loops with nobody to tell; the one caller
   * that has a user in front of it (`PATCH /api/accounts/:id`) uses this.
   */
  async ensureFreshTokenChecked(
    id: string,
    opts?: { retryRejected?: boolean },
  ): Promise<{ account: AccountWithTokens | null; rejected: boolean }> {
    const acc = this.getWithTokens(id);
    if (!acc) return { account: null, rejected: false };
    // Only OAuth tokens need refresh
    if (!acc.accessToken.startsWith("sk-ant-oat")) return { account: acc, rejected: false };
    if (!acc.expiresAt) return { account: acc, rejected: false };
    // A grant the server already rejected cannot come back on its own, and this method is
    // on the usage poller's five-minute path. Callers acting on a deliberate user gesture
    // (enable, test token) pass retryRejected so a false positive is always one click from
    // being re-tested.
    if (acc.reauthRequired && !opts?.retryRejected) return { account: null, rejected: true };
    const nowS = Math.floor(Date.now() / 1000);
    if (acc.expiresAt - nowS > PREFLIGHT_REFRESH_BUFFER_S) return { account: acc, rejected: false }; // still fresh
    try {
      console.log(`[accounts] Pre-flight refresh for ${acc.email ?? id} (expires in ${acc.expiresAt - nowS}s, buffer=${PREFLIGHT_REFRESH_BUFFER_S}s)`);
      await this.refreshAccessToken(id, false, false, PREFLIGHT_REFRESH_BUFFER_S);
      return { account: this.getWithTokens(id), rejected: false };
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      console.error(`[accounts] Pre-flight refresh failed for ${id}: ${msg}`);
      return { account: null, rejected: /invalid_grant|invalid_request/.test(msg) };
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
    refreshExpiresAt?: number | null;
    label?: string;
    profileData?: OAuthProfileData;
  }): Account {
    const grantedAt = Math.floor(Date.now() / 1000);
    // Check for duplicate — update existing account tokens instead of creating new
    const dup = this.findDuplicate(params.email, params.profileData);
    if (dup) {
      this.updateTokens(dup.id, params.accessToken, params.refreshToken, params.expiresAt);
      // Signing in again starts a brand new grant, so the 28-day clock restarts here.
      // This is the branch that matters in practice: re-authenticating an account that
      // already exists is how every expiry is recovered from, and it is exactly where
      // created_at stays frozen at the row's original insert.
      updateAccount(dup.id, {
        granted_at: grantedAt,
        refresh_expires_at: params.refreshExpiresAt ?? null,
        reauth_required: 0,
      });
      if (params.profileData) {
        updateAccount(dup.id, { profile_json: JSON.stringify(params.profileData) });
      }
      if (params.label) updateAccount(dup.id, { label: params.label });
      if (params.email) updateAccount(dup.id, { email: params.email });
      // After the email lands, or the first re-add of a row that had none logs a UUID.
      this.noteParkSurvivedReAdd(dup.id);
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
      granted_at: grantedAt,
      refresh_expires_at: params.refreshExpiresAt ?? null,
      reauth_required: 0,
      last_refresh_attempt_at: null,
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
      // Mirrors updateTokens(): a fresh token ends a cooldown, but a park is a decision
      // about the rotation and pasting the token in again does not reverse it. This was the
      // one door left that force-enabled, which is how the two paths disagreed.
      const parked = getAccountById(dup.id)?.status === "disabled";
      updateAccount(dup.id, {
        access_token: encrypt(params.apiKey),
        cooldown_until: null,
        ...(parked ? {} : { status: "active" as const }),
      });
      if (info.profileData) updateAccount(dup.id, { profile_json: JSON.stringify(info.profileData) });
      if (email) updateAccount(dup.id, { email });
      this.noteParkSurvivedReAdd(dup.id);
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
      // An API key is not an OAuth grant: it has no family to expire and no sign-in to date.
      granted_at: null,
      refresh_expires_at: null,
      reauth_required: 0,
      last_refresh_attempt_at: null,
    });
    return this.toAccount(getAccountById(id)!);
  }

  updateTokens(id: string, accessToken: string, refreshToken: string, expiresAt: number): void {
    // A disabled account keeps that status. Usage polling refreshes parked accounts on
    // purpose (a GET costs no quota), and export does the same before writing a backup;
    // activating here put them back in the chat rotation behind the user's back, so the
    // toggle looked like it had been forgotten — most visibly after a restart, which
    // polls immediately. Cooldown still clears for everything else: a fresh token is
    // precisely what ends a cooldown.
    const parked = getAccountById(id)?.status === "disabled";
    updateAccount(id, {
      access_token: encrypt(accessToken),
      refresh_token: encrypt(refreshToken),
      expires_at: expiresAt,
      // The cooldown clears either way — a fresh token is what ends one, and leaving the
      // timestamp on a parked account would resurrect it the moment the park is lifted.
      cooldown_until: null,
      // Holding live tokens is the only thing that clears a re-auth demand. Every door
      // that lands here — sign-in, import, a successful refresh — has just proved the
      // credential works, which is exactly the condition the flag was tracking.
      reauth_required: 0,
      ...(parked ? {} : { status: "active" as const }),
    });
  }

  /**
   * Both re-add doors land here once the new tokens are stored. Neither lifts a park —
   * disabling is a decision about the rotation, and carrying credentials in does not reverse
   * it — but landing tokens and then showing nothing is exactly what made the OAuth path look
   * like a no-op. Saying so is the whole point; keeping it in one place is what stops the two
   * doors from drifting apart again.
   */
  private noteParkSurvivedReAdd(id: string): void {
    const row = getAccountById(id);
    if (row?.status !== "disabled") return;
    console.log(
      `[accounts] Tokens updated for ${row.email ?? id} — account stays disabled; enable it in Settings`,
    );
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
        // Signing in again refreshes the tokens but no longer re-enables anything, so the
        // text says what actually happens: get a live token in, then flip it back on here.
        throw new Error(
          "Cannot re-enable expired temporary account. Sign in again or import a fresh backup to refresh its tokens, then enable it here.",
        );
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
      refreshExpiresAt: tokens.refreshExpiresAt,
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
      refreshExpiresAt: tokens.refreshExpiresAt,
      profileData,
    });
  }

  async exchangeCode(code: string, verifier: string, redirectUri: string, state?: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    refreshExpiresAt: number | null;
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
    const data = await res.json() as Record<string, unknown> & {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      account?: { email_address?: string };
    };
    noteUnknownTokenFields(data, "authorization_code");
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
      refreshExpiresAt: readRefreshExpiry(data),
      email: data.account?.email_address ?? "",
    };
  }

  /**
   * Refresh an OAuth access token using the stored refresh token.
   * Uses a per-account mutex to prevent concurrent refresh calls from racing
   * (Anthropic rotates refresh tokens — only one call per token is valid).
   * Also skips the OAuth call if the DB token was already refreshed by another session.
   * @param disableOnFail - if true, disable the account when refresh fails (default: true).
   *   Background/startup refresh should pass false to avoid disabling accounts prematurely.
   * @param force - if true, bypass the skip-if-fresh check (use after 401 errors where
   *   the token is demonstrably invalid despite having a future expiresAt).
   * @param freshThresholdS - skip the OAuth call if the DB token still has more than this
   *   many seconds left. Callers doing proactive refresh must pass their own buffer here,
   *   otherwise this guard silently cancels the refresh they asked for.
   */
  async refreshAccessToken(accountId: string, disableOnFail = true, force = false, freshThresholdS = 60): Promise<void> {
    // Dedup: if a refresh is already in progress for this account, wait for it instead of racing
    const pending = this.pendingRefreshes.get(accountId);
    if (pending) {
      console.log(`[accounts] Refresh already in progress for ${accountId} — waiting for it`);
      return pending;
    }

    const promise = this._doRefreshAccessToken(accountId, disableOnFail, force, freshThresholdS);
    this.pendingRefreshes.set(accountId, promise);
    try {
      await promise;
    } finally {
      this.pendingRefreshes.delete(accountId);
    }
  }

  /**
   * POST the refresh grant, retrying transient failures with backoff.
   *
   * Retrying matters more now than it used to. This runs at the point of use, inside a
   * five-minute window before the token is needed, so a network blip that burns the
   * attempt costs the turn rather than merely deferring to the next sweep — there is no
   * next sweep.
   *
   * An earlier version of this comment claimed refresh tokens outlive their access tokens
   * by days, citing 324 refreshes with zero `invalid_grant`. That held only inside one
   * grant's lifetime. Across grants it is wrong in the way that matters: the family is
   * revoked on a fixed schedule from sign-in (GRANT_LIFETIME_S), and when it goes, the
   * refresh token is rejected on its first use while the access token minted alongside it
   * is still valid. No amount of retrying recovers that — only a new sign-in does.
   */
  private async postRefreshGrant(refreshToken: string, label: string): Promise<Response> {
    const backoffMs = [2_000, 6_000];
    for (let attempt = 0; ; attempt++) {
      const retryIn = backoffMs[attempt];
      try {
        const res = await fetch(OAUTH_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "refresh_token",
            client_id: OAUTH_CLIENT_ID,
            refresh_token: refreshToken,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        // 429/5xx leave the refresh token intact — retrying is safe and cheaper than waiting a full cycle
        if (retryIn !== undefined && (res.status === 429 || res.status >= 500)) {
          console.warn(`[accounts] Transient ${res.status} refreshing ${label} — retrying in ${retryIn}ms`);
          await Bun.sleep(retryIn);
          continue;
        }
        return res;
      } catch (e) {
        if (retryIn === undefined) throw e;
        console.warn(`[accounts] Network error refreshing ${label} (${(e as Error).message}) — retrying in ${retryIn}ms`);
        await Bun.sleep(retryIn);
      }
    }
  }

  private async _doRefreshAccessToken(accountId: string, disableOnFail: boolean, force = false, freshThresholdS = 60): Promise<void> {
    const account = this.getWithTokens(accountId);
    if (!account) throw new Error(`Account ${accountId} not found`);
    // Skip refresh for temporary accounts (no refresh token)
    if (!account.refreshToken || account.refreshToken === "") {
      throw new Error(`Account ${accountId} has no refresh token (temporary account)`);
    }
    // Skip if token was already refreshed by another session (still fresh).
    // But when force=true (after a 401), always refresh — the token may be
    // revoked server-side despite having a future expiresAt.
    const nowS = Math.floor(Date.now() / 1000);
    if (!force && account.expiresAt && account.expiresAt - nowS > freshThresholdS) {
      console.log(`[accounts] Token for ${account.email ?? accountId} is already fresh (expires in ${account.expiresAt - nowS}s, threshold=${freshThresholdS}s) — skipping OAuth refresh`);
      return;
    }
    updateAccount(accountId, { last_refresh_attempt_at: nowS });
    const res = await this.postRefreshGrant(account.refreshToken, account.email ?? accountId);
    if (!res.ok) {
      const errorBody = await res.text().catch(() => "");
      console.error(`[accounts] Refresh failed for ${accountId}: ${res.status} ${errorBody}`);
      const rejected = errorBody.includes("invalid_grant") || errorBody.includes("invalid_request");
      if (rejected) {
        // Another session/process may have refreshed (and rotated) the token between our read
        // and this OAuth call, making this failure stale. Detect that by comparing against the
        // expiry we read — testing "is it fresh" instead would swallow genuine rejections
        // whenever we refresh proactively, while the token is still valid.
        const recheckAccount = this.getWithTokens(accountId);
        if (recheckAccount?.expiresAt && recheckAccount.expiresAt !== account.expiresAt) {
          console.log(`[accounts] Refresh failed with invalid_grant but DB token changed — another session refreshed it`);
          return;
        }
        // Do NOT wipe the refresh token. On multi-device/multi-process setups the token is
        // usually rotated elsewhere, not truly dead; clearing it bricks the local copy
        // permanently with no recovery path (esp. for parked/disabled accounts). Preserve
        // it so re-enable / re-import / re-sync can restore access.
        console.warn(`[accounts] Refresh token rejected for ${account.email ?? accountId} — preserving token for recovery (not clearing)`);
        // Anthropic ends the refresh-token family a fixed time after the grant, so a
        // rejection here is terminal: every subsequent attempt returns the same 400.
        // Recording it stops the retry loop that otherwise runs every few minutes for
        // days — one live install logged 17,510 of them — and gives the UI something to
        // show besides an account that still claims to be active.
        updateAccount(accountId, { reauth_required: 1 });
      }
      if (disableOnFail) {
        this.setDisabled(accountId);
      }
      throw new Error(`Token refresh failed for account ${accountId}: ${res.status} ${errorBody}`);
    }
    const data = await res.json() as Record<string, unknown> & {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    noteUnknownTokenFields(data, "refresh_token");
    const refreshExpiresAt = readRefreshExpiry(data);
    console.log(`[accounts] Token refreshed for ${account.email ?? accountId} (expires_in=${data.expires_in}s, new_refresh=${!!data.refresh_token}, refresh_expires_at=${refreshExpiresAt ?? "not reported"})`);
    this.updateTokens(
      accountId,
      data.access_token,
      data.refresh_token ?? account.refreshToken,
      Math.floor(Date.now() / 1000) + data.expires_in,
    );
    // Only overwrite when the server said something. A rotation that reports nothing
    // must not erase an expiry an earlier response did report.
    if (refreshExpiresAt) updateAccount(accountId, { refresh_expires_at: refreshExpiresAt });
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
   *   Default false = temporary export (access-only, ~1h — see `refreshBeforeExport`,
   *   which freshens the access token first so the window starts at export time).
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
          // An account parked on THIS machine stays parked: the import carries tokens, not
          // the local decision about who is in the rotation. A new account still takes the
          // backup's status below, since there is no local decision to respect. An account
          // the failed-refresh path disabled is recoverable in one click — the import gives
          // it back a live refresh token, which is what setEnabled() checks for.
          const parked = existing.status === "disabled";
          updateAccount(existing.id, {
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_at: row.expires_at,
            ...(parked ? {} : { status: "active" as const }),
          });
          imported++;
          // The usage poller and export both refresh a parked account, because a token
          // nothing ever refreshes eventually dies. This one is different: it is not
          // keeping the token alive, it is claiming ownership of it — and claiming a token
          // for an account this machine has taken out of the rotation buys nothing here
          // while invalidating the machine still using it. Enabling the account claims it.
          if (!parked) fullTransferIds.push(existing.id);
          console.log(`[accounts] Updated ${row.email ?? existing.id} tokens from import`);
        }
        continue; // skip if import doesn't have refresh token
      }

      // New account — insert
      let accessToken = row.access_token;
      if (!looksEncrypted(accessToken)) accessToken = encrypt(accessToken);
      const refreshToken = hasRefresh ? (looksEncrypted(row.refresh_token) ? row.refresh_token : encrypt(row.refresh_token)) : encrypt("");
      // The column has no CHECK constraint and the blob is user-supplied, so anything
      // outside the three real statuses lands as active. A stray value reads as *on* in
      // the UI (`status !== "disabled"`) while never being selectable for a turn.
      const importedStatus =
        row.status === "disabled" || row.status === "cooldown" ? row.status : "active";
      insertAccount({
        id: row.id,
        label: row.label,
        email: row.email,
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: row.expires_at,
        status: importedStatus,
        cooldown_until: row.cooldown_until,
        priority: row.priority ?? 0,
        total_requests: row.total_requests ?? 0,
        last_used_at: row.last_used_at,
        profile_json: row.profile_json ?? null,
        // A backup written before these columns existed has none of this; null means
        // "unknown", which is what the import genuinely knows.
        granted_at: row.granted_at ?? null,
        refresh_expires_at: row.refresh_expires_at ?? null,
        reauth_required: 0,
        last_refresh_attempt_at: null,
      });
      imported++;
      if (hasRefresh && importedStatus !== "disabled") fullTransferIds.push(row.id);
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

  startAccountMaintenance(): void {
    if (acctHotState.refreshTimer) return;
    const CHECK_INTERVAL_MS = 5 * 60_000;

    // There is deliberately no token-refresh sweep here any more.
    //
    // It used to refresh every account an hour before expiry, which rotated an idle
    // account's token three or four times a day for nothing. That bought no safety: the
    // refresh-token family dies on grant age (see GRANT_LIFETIME_S), not on idleness, so
    // keeping a parked token warm never extended its life — it only widened the window in
    // which two holders of the same credential could rotate over each other.
    //
    // Claude Code refreshes where the token is consumed and nowhere else, and PPM now
    // matches: ensureFreshTokenChecked() on the turn path, the proxy, and the usage
    // poller. What survives on this timer is the one job no request path covers.

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
    cleanupExpiredTemporary();
    acctHotState.refreshTimer = setInterval(() => {
      cleanupExpiredTemporary();
    }, CHECK_INTERVAL_MS);

    if (typeof acctHotState.refreshTimer === "object" && acctHotState.refreshTimer !== null && "unref" in acctHotState.refreshTimer) {
      (acctHotState.refreshTimer as NodeJS.Timeout).unref();
    }
  }

  stopAccountMaintenance(): void {
    if (acctHotState.refreshTimer) {
      clearInterval(acctHotState.refreshTimer);
      acctHotState.refreshTimer = null;
    }
  }
}

export const accountService = new AccountService();
