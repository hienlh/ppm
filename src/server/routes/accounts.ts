import { Hono } from "hono";
import type { Context } from "hono";
import { accountService } from "../../services/account.service.ts";
import { accountSelector } from "../../services/account-selector.service.ts";
import { updateAccount } from "../../services/db.service.ts";
import { getAllAccountUsages, getUsageForAccount } from "../../services/claude-usage.service.ts";
import { ok, err } from "../../types/api.ts";

export const accountsRoutes = new Hono();

function getBaseUrl(c: Context): string {
  // Respect X-Forwarded-Host/Origin for dev proxy (Vite → backend)
  const fwdHost = c.req.header("x-forwarded-host");
  const fwdProto = c.req.header("x-forwarded-proto") ?? "http";
  if (fwdHost) return `${fwdProto}://${fwdHost}`;
  const origin = c.req.header("origin");
  if (origin) return origin;
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}`;
}

function getCallbackUrl(c: Context): string {
  return `${getBaseUrl(c)}/api/accounts/oauth/callback`;
}

function getUiBase(c: Context): string {
  return getBaseUrl(c);
}

/** GET /api/accounts — includes hasRefreshToken flag for UI to distinguish temporary accounts */
accountsRoutes.get("/", (c) => {
  const accounts = accountService.list().map((acc) => ({
    ...acc,
    hasRefreshToken: accountService.hasRefreshToken(acc.id),
  }));
  return c.json(ok(accounts));
});

/** GET /api/accounts/active — which account will be used next */
accountsRoutes.get("/active", (c) => {
  const lastId = accountSelector.lastPickedId;
  if (!lastId) {
    // No account picked yet — peek at what next() would return without consuming it
    const accounts = accountService.list().filter((a) => a.status === "active");
    if (accounts.length === 0) return c.json(ok(null));
    return c.json(ok(accounts[0]));
  }
  const account = accountService.list().find((a) => a.id === lastId) ?? null;
  return c.json(ok(account));
});

/** GET /api/accounts/settings */
accountsRoutes.get("/settings", (c) => {
  return c.json(ok({
    strategy: accountSelector.getStrategy(),
    maxRetry: accountSelector.getMaxRetry(),
    activeCount: accountSelector.activeCount(),
  }));
});

/** PUT /api/accounts/settings */
accountsRoutes.put("/settings", async (c) => {
  const body = await c.req.json<{ strategy?: string; maxRetry?: number }>();
  if (body.strategy !== undefined) {
    if (!["round-robin", "fill-first", "lowest-usage"].includes(body.strategy)) {
      return c.json(err("strategy must be round-robin, fill-first, or lowest-usage"), 400);
    }
    accountSelector.setStrategy(body.strategy as "round-robin" | "fill-first" | "lowest-usage");
  }
  if (body.maxRetry !== undefined) {
    if (!Number.isInteger(body.maxRetry) || body.maxRetry < 0) {
      return c.json(err("maxRetry must be a non-negative integer"), 400);
    }
    accountSelector.setMaxRetry(body.maxRetry);
  }
  return c.json(ok({
    strategy: accountSelector.getStrategy(),
    maxRetry: accountSelector.getMaxRetry(),
    activeCount: accountSelector.activeCount(),
  }));
});

/** POST /api/accounts — add account manually with API key */
accountsRoutes.post("/", async (c) => {
  const body = await c.req.json<{ apiKey: string; label?: string }>();
  if (!body.apiKey || typeof body.apiKey !== "string") {
    return c.json(err("apiKey is required"), 400);
  }
  try {
    const account = await accountService.addManual({
      apiKey: body.apiKey.trim(),
      label: body.label?.trim() || null,
    });
    return c.json(ok(account));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

/** GET /api/accounts/oauth/start → redirect to Claude OAuth (legacy, localhost callback) */
accountsRoutes.get("/oauth/start", (c) => {
  const referer = c.req.header("referer");
  let callbackBase: string;
  if (referer) {
    const refUrl = new URL(referer);
    callbackBase = `${refUrl.protocol}//${refUrl.host}`;
  } else {
    callbackBase = getBaseUrl(c);
  }
  const callbackUrl = `${callbackBase}/api/accounts/oauth/callback`;
  const url = accountService.startOAuthFlow(callbackUrl);
  return c.redirect(url);
});

/** GET /api/accounts/oauth/url → return OAuth URL for manual code flow */
accountsRoutes.get("/oauth/url", (c) => {
  const { url, state } = accountService.startOAuthCodeFlow();
  return c.json(ok({ url, state }));
});

/** POST /api/accounts/oauth/exchange → exchange code from platform callback */
accountsRoutes.post("/oauth/exchange", async (c) => {
  const body = await c.req.json<{ code: string; state: string }>();
  if (!body.code || !body.state) return c.json(err("code and state are required"), 400);
  try {
    const account = await accountService.completeOAuthCodeFlow(body.code.trim(), body.state);
    return c.json(ok(account));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

/** GET /api/accounts/oauth/callback — exchange code for tokens */
accountsRoutes.get("/oauth/callback", async (c) => {
  const { code, state, error } = c.req.query();
  const successRedirect = `${getUiBase(c)}/#/settings/accounts`;

  if (error || !code || !state) {
    return c.redirect(`${successRedirect}?error=${encodeURIComponent(error ?? "missing_params")}`);
  }
  try {
    await accountService.completeOAuthFlow(code, state, getCallbackUrl(c));
    return c.redirect(`${successRedirect}?success=1`);
  } catch (e) {
    return c.redirect(`${successRedirect}?error=${encodeURIComponent((e as Error).message)}`);
  }
});

/** POST /api/accounts/oauth/refresh/:id */
accountsRoutes.post("/oauth/refresh/:id", async (c) => {
  const { id } = c.req.param();
  try {
    await accountService.refreshAccessToken(id);
    return c.json(ok({ refreshed: true }));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

/** POST /api/accounts/export — download password-encrypted accounts backup */
accountsRoutes.post("/export", async (c) => {
  try {
    const { password, accountIds, includeRefreshToken, refreshBeforeExport } = await c.req.json() as {
      password: string; accountIds?: string[]; includeRefreshToken?: boolean; refreshBeforeExport?: boolean;
    };
    if (!password) return c.json(err("Password required"), 400);
    if (refreshBeforeExport) await accountService.refreshBeforeExport(accountIds);
    const blob = accountService.exportEncrypted(password, accountIds, includeRefreshToken ?? false);
    c.header("Content-Disposition", "attachment; filename=ppm-accounts-backup.json");
    c.header("Content-Type", "application/json");
    return c.body(blob);
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

/** POST /api/accounts/import — restore accounts from password-encrypted backup */
accountsRoutes.post("/import", async (c) => {
  try {
    const { data, password } = await c.req.json() as { data: string; password: string };
    if (!data) return c.json(err("Backup data required"), 400);
    if (!password) return c.json(err("Password required"), 400);
    const result = await accountService.importEncrypted(data, password);
    return c.json(ok(result));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

/** GET /api/accounts/usage — all accounts usage batch */
accountsRoutes.get("/usage", (c) => {
  return c.json(ok(getAllAccountUsages()));
});

/** GET /api/accounts/:id/usage — single account usage */
accountsRoutes.get("/:id/usage", (c) => {
  const { id } = c.req.param();
  return c.json(ok(getUsageForAccount(id)));
});

/** POST /api/accounts/:id/verify — re-verify token & refresh profile */
accountsRoutes.post("/:id/verify", async (c) => {
  const { id } = c.req.param();
  const account = accountService.getWithTokens(id);
  if (!account) return c.json(err("Account not found"), 404);
  try {
    const result = await accountService.verifyToken(account.accessToken);
    if (result.valid && result.profileData) {
      updateAccount(id, { profile_json: JSON.stringify(result.profileData) });
      if (result.email) updateAccount(id, { email: result.email });
    }
    return c.json(ok(result));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /api/accounts/test-export — simulate export: returns decrypted tokens + current DB tokens for comparison */
accountsRoutes.post("/test-export", async (c) => {
  try {
    const { accountIds, includeRefreshToken } = await c.req.json() as { accountIds: string[]; includeRefreshToken?: boolean };
    if (!accountIds?.length) return c.json(err("accountIds required"), 400);

    // Snapshot current tokens BEFORE export (export calls refreshBeforeExport which may change tokens)
    const preExportTokens = accountIds.map((id) => {
      const acc = accountService.getWithTokens(id);
      if (!acc) return null;
      return { id, label: acc.label, email: acc.email, accessToken: acc.accessToken, expiresAt: acc.expiresAt };
    }).filter(Boolean) as { id: string; label: string | null; email: string | null; accessToken: string; expiresAt: number | null }[];

    // Do export with a temp password, then decrypt to get exported tokens
    const tmpPwd = "test-export-" + Date.now();
    await accountService.refreshBeforeExport(accountIds);
    const blob = accountService.exportEncrypted(tmpPwd, accountIds, includeRefreshToken ?? false);

    // Decrypt to get raw exported tokens
    const { decryptWithPassword } = await import("../../lib/account-crypto.ts");
    const rows = JSON.parse(decryptWithPassword(blob, tmpPwd)) as { id: string; label: string; email: string; access_token: string; expires_at: number | null }[];

    // Get post-export current tokens (may differ if refreshBeforeExport changed them)
    const postExportTokens = accountIds.map((id) => {
      const acc = accountService.getWithTokens(id);
      if (!acc) return null;
      return { id, label: acc.label, email: acc.email, accessToken: acc.accessToken, expiresAt: acc.expiresAt };
    }).filter(Boolean) as { id: string; label: string | null; email: string | null; accessToken: string; expiresAt: number | null }[];

    const result = rows.map((row) => {
      const pre = preExportTokens.find((t) => t.id === row.id);
      const post = postExportTokens.find((t) => t.id === row.id);
      return {
        id: row.id,
        label: row.label,
        email: row.email,
        preExportToken: pre?.accessToken ? pre.accessToken.slice(0, 20) + "..." : null,
        preExportTokenFull: pre?.accessToken ?? null,
        exportedToken: row.access_token.slice(0, 20) + "...",
        exportedTokenFull: row.access_token,
        postExportToken: post?.accessToken ? post.accessToken.slice(0, 20) + "..." : null,
        postExportTokenFull: post?.accessToken ?? null,
        preExportExpires: pre?.expiresAt ?? null,
        exportedExpires: row.expires_at,
        postExportExpires: post?.expiresAt ?? null,
        tokenChanged: pre?.accessToken !== post?.accessToken,
      };
    });
    return c.json(ok(result));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

/** POST /api/accounts/test-raw-token — test an arbitrary access token against profile API */
accountsRoutes.post("/test-raw-token", async (c) => {
  const { token } = await c.req.json<{ token: string }>();
  if (!token) return c.json(err("token required"), 400);
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
    if (res.status === 200) return c.json(ok({ status: "valid", code: 200 }));
    if (res.status === 429) return c.json(ok({ status: "valid_rate_limited", code: 429 }));
    const body = await res.text().catch(() => "");
    return c.json(ok({ status: "invalid", code: res.status, error: body.slice(0, 300) }));
  } catch (e) {
    return c.json(ok({ status: "error", error: (e as Error).message }));
  }
});

/** POST /api/accounts/:id/test-token — test access token validity + optionally refresh token */
accountsRoutes.post("/:id/test-token", async (c) => {
  const { id } = c.req.param();
  const { testRefresh } = await c.req.json<{ testRefresh?: boolean }>().catch(() => ({ testRefresh: false }));
  const account = accountService.getWithTokens(id);
  if (!account) return c.json(err("Account not found"), 404);

  const result: {
    accessToken: { status: string; code?: number; error?: string };
    refreshToken?: { status: string; code?: number; expiresIn?: number; newRefreshToken?: boolean; error?: string };
  } = { accessToken: { status: "unknown" } };

  // Test access token via profile API
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/profile", {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${account.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "ppm/1.0",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 200) {
      result.accessToken = { status: "valid", code: 200 };
    } else if (res.status === 429) {
      result.accessToken = { status: "valid_rate_limited", code: 429 };
    } else {
      const body = await res.text().catch(() => "");
      result.accessToken = { status: "invalid", code: res.status, error: body.slice(0, 300) };
    }
  } catch (e) {
    result.accessToken = { status: "error", error: (e as Error).message };
  }

  // Test refresh token
  if (testRefresh && account.refreshToken) {
    try {
      await accountService.refreshAccessToken(id, false);
      const refreshed = accountService.getWithTokens(id);
      result.refreshToken = {
        status: "valid",
        code: 200,
        expiresIn: refreshed?.expiresAt ? refreshed.expiresAt - Math.floor(Date.now() / 1000) : undefined,
        newRefreshToken: true,
      };
    } catch (e) {
      result.refreshToken = { status: "invalid", error: (e as Error).message };
    }
  } else if (testRefresh && !account.refreshToken) {
    result.refreshToken = { status: "no_token", error: "No refresh token (temporary account)" };
  }

  return c.json(ok(result));
});

/** DELETE /api/accounts/:id */
accountsRoutes.delete("/:id", (c) => {
  const { id } = c.req.param();
  accountService.remove(id);
  return c.json(ok({ deleted: true }));
});

/** PATCH /api/accounts/:id — { status: "active" | "disabled" } */
accountsRoutes.patch("/:id", async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json<{ status?: string }>();
  try {
    if (body.status === "disabled") accountService.setDisabled(id);
    else if (body.status === "active") accountService.setEnabled(id);
    else return c.json(err("status must be active or disabled"), 400);
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
  const account = accountService.list().find((a) => a.id === id) ?? null;
  return c.json(ok(account));
});
