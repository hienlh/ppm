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

/** GET /api/accounts */
accountsRoutes.get("/", (c) => {
  return c.json(ok(accountService.list()));
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
    if (!["round-robin", "fill-first"].includes(body.strategy)) {
      return c.json(err("strategy must be round-robin or fill-first"), 400);
    }
    accountSelector.setStrategy(body.strategy as "round-robin" | "fill-first");
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
    const { password, accountIds } = await c.req.json() as { password: string; accountIds?: string[] };
    if (!password) return c.json(err("Password required"), 400);
    const blob = accountService.exportEncrypted(password, accountIds);
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
    const count = accountService.importEncrypted(data, password);
    return c.json(ok({ imported: count }));
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
  if (body.status === "disabled") accountService.setDisabled(id);
  else if (body.status === "active") accountService.setEnabled(id);
  else return c.json(err("status must be active or disabled"), 400);
  const account = accountService.list().find((a) => a.id === id) ?? null;
  return c.json(ok(account));
});
