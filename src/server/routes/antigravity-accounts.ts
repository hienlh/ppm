import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import {
  getAllAntigravityUsages,
  getAntigravityStrategy,
  listAntigravityAccounts,
  removeAntigravityAccount,
  setAntigravityAccountStatus,
  setAntigravityStrategy,
  syncDefaultAntigravityAccount,
  type AntigravityStrategy,
} from "../../services/antigravity-account.service.ts";
import {
  cancelAntigravityLogin,
  getAntigravityLoginStatus,
  startAntigravityLogin,
  submitAntigravityLoginCode,
} from "../../services/antigravity-account-login.ts";
import { pickAntigravityAccount } from "../../services/account-pick.service.ts";
import { registerUsageSource } from "../../services/provider-usage/usage-registry.ts";
import { antigravityUsageSource } from "../../providers/antigravity/antigravity-usage.ts";

/** Antigravity multi-account management. Mounted under /api/antigravity-accounts (auth-guarded). */
export const antigravityAccountsRoutes = new Hono();

antigravityAccountsRoutes.get("/", async (c) => {
  registerUsageSource(antigravityUsageSource);
  await syncDefaultAntigravityAccount();
  return c.json(
    ok({
      accounts: listAntigravityAccounts(),
      strategy: getAntigravityStrategy(),
    }),
  );
});

antigravityAccountsRoutes.get("/usage", async (c) => {
  registerUsageSource(antigravityUsageSource);
  return c.json(ok(await getAllAntigravityUsages()));
});

antigravityAccountsRoutes.post("/pick", async (c) => {
  registerUsageSource(antigravityUsageSource);
  await syncDefaultAntigravityAccount();
  return c.json(ok(await pickAntigravityAccount()));
});

antigravityAccountsRoutes.put("/strategy", async (c) => {
  const body = await c.req
    .json<{ strategy?: AntigravityStrategy }>()
    .catch(() => ({} as { strategy?: AntigravityStrategy }));
  const allowed: AntigravityStrategy[] = ["round-robin", "fill-first", "lowest-usage"];
  if (!body.strategy || !allowed.includes(body.strategy)) {
    return c.json(err("strategy must be one of: " + allowed.join(", ")), 400);
  }
  setAntigravityStrategy(body.strategy);
  return c.json(ok({ strategy: body.strategy }));
});

antigravityAccountsRoutes.patch("/:id", async (c) => {
  const body = await c.req
    .json<{ status?: string }>()
    .catch(() => ({} as { status?: string }));
  if (body.status !== "active" && body.status !== "disabled") {
    return c.json(err("status must be active or disabled"), 400);
  }
  const updated = setAntigravityAccountStatus(c.req.param("id"), body.status);
  if (!updated) return c.json(err("Account not found"), 404);
  return c.json(ok(updated));
});

antigravityAccountsRoutes.delete("/:id", (c) => {
  removeAntigravityAccount(c.req.param("id"));
  return c.json(ok({ removed: true }));
});

antigravityAccountsRoutes.post("/login", async (c) => {
  const body = await c.req
    .json<{ label?: unknown; accountId?: unknown }>()
    .catch(() => ({} as { label?: unknown; accountId?: unknown }));
  if (body.label !== undefined && typeof body.label !== "string") {
    return c.json(err("label must be a string"), 400);
  }
  if (body.accountId !== undefined && typeof body.accountId !== "string") {
    return c.json(err("accountId must be a string"), 400);
  }
  if (body.accountId === "default") {
    return c.json(err("Cannot re-login the default ambient account (~/.gemini). Sign in via Antigravity Desktop or add a new account."), 400);
  }
  c.header("Cache-Control", "no-store");
  try {
    return c.json(ok(await startAntigravityLogin(body.label, body.accountId)));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

antigravityAccountsRoutes.post("/login/:id/callback", async (c) => {
  const body = await c.req
    .json<{ code?: unknown }>()
    .catch(() => ({} as { code?: unknown }));
  c.header("Cache-Control", "no-store");
  if (typeof body.code !== "string" || !body.code.trim()) {
    return c.json(err("code is required"), 400);
  }
  // Token exchange + Language Server verification can exceed Bun's 10s idle timeout.
  (c.env as { timeout?: (request: Request, seconds: number) => void } | undefined)?.timeout?.(c.req.raw, 0);
  try {
    const status = await submitAntigravityLoginCode(c.req.param("id"), body.code);
    if (status.state === "error") {
      return c.json(err(status.error), 400);
    }
    if (status.state !== "done") {
      return c.json(err("Login code submission is still pending"), 409);
    }
    return c.json(ok(status));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

antigravityAccountsRoutes.get("/login/:id/status", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(ok(getAntigravityLoginStatus(c.req.param("id"))));
});

antigravityAccountsRoutes.delete("/login/:id", (c) => {
  cancelAntigravityLogin(c.req.param("id"));
  return c.json(ok({ cancelled: true }));
});
