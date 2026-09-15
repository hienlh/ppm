import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import { listCodexAccounts, removeCodexAccount, getAllCodexUsages, getCodexStrategy, setCodexStrategy, selectCodexAccount, setCodexAccountStatus, type CodexStrategy } from "../../services/codex-account.service.ts";
import { addApiKeyAccount, startDeviceLogin, getDeviceLoginStatus, cancelDeviceLogin } from "../../services/codex-account-login.ts";
import { exportCodexEncrypted, importCodexEncrypted } from "../../services/codex-account-portability.ts";

/** Codex multi-account management. Mounted under /api/codex-accounts (auth-guarded). */
export const codexAccountsRoutes = new Hono();

codexAccountsRoutes.get("/", (c) => c.json(ok({ accounts: listCodexAccounts(), strategy: getCodexStrategy() })));

/** Per-account quota map { [accountId]: UsageInfo }. */
codexAccountsRoutes.get("/usage", async (c) => c.json(ok(await getAllCodexUsages())));

/**
 * POST /api/codex-accounts/pick — claim the account that will serve a new chat tab.
 *
 * Mirrors the Claude side: a consuming pick, so round-robin advances and consecutive tabs
 * land on different accounts. Usage is read once here and handed to the selector, which is
 * what lets it skip accounts with no five-hour room left — the synchronous `peekCodexAccount`
 * has no way to reach that data, which is why the toolbar could never name an account before
 * the first turn under round-robin.
 *
 * Null when no account is managed: chats then run on the ambient ~/.codex login, which has
 * no id to bind and nothing to choose between.
 */
codexAccountsRoutes.post("/pick", async (c) => {
  if (listCodexAccounts().length === 0) return c.json(ok(null));
  const usages = await getAllCodexUsages();
  // A failed usage fetch yields {} → +Infinity, which the selector reads as "unknown", not
  // as "capped": an account we could not measure stays a candidate.
  const picked = selectCodexAccount({ usageOf: (id) => usages[id]?.fiveHour ?? Number.POSITIVE_INFINITY });
  if (!picked) return c.json(ok(null));
  return c.json(ok({ id: picked.id, label: picked.label }));
});

/**
 * PATCH /api/codex-accounts/:id — switch an account on or off.
 *
 * Mirrors the shape of the Claude route so the two panels can share one control, but not its
 * pre-flight token check: that exists for Anthropic OAuth refresh tokens, which have nothing
 * to do with how a Codex account authenticates. Nothing to prove here means this answers
 * immediately instead of taking the better part of a minute.
 */
codexAccountsRoutes.patch("/:id", async (c) => {
  const body = await c.req.json<{ status?: string }>().catch(() => ({} as { status?: string }));
  if (body.status !== "active" && body.status !== "disabled") {
    return c.json(err("status must be active or disabled"), 400);
  }
  const updated = setCodexAccountStatus(c.req.param("id"), body.status);
  if (!updated) return c.json(err("Account not found"), 404);
  return c.json(ok(updated));
});

/** Set the selection strategy. */
codexAccountsRoutes.put("/strategy", async (c) => {
  const body = await c.req.json<{ strategy?: CodexStrategy }>().catch(() => ({} as { strategy?: CodexStrategy }));
  const allowed: CodexStrategy[] = ["round-robin", "fill-first", "lowest-usage"];
  if (!body.strategy || !allowed.includes(body.strategy)) return c.json(err("strategy must be one of: " + allowed.join(", ")), 400);
  setCodexStrategy(body.strategy);
  return c.json(ok({ strategy: body.strategy }));
});

/** Add an apiKey account (headless, instant). */
codexAccountsRoutes.post("/api-key", async (c) => {
  const body = await c.req.json<{ apiKey?: string; label?: string }>().catch(() => ({} as { apiKey?: string; label?: string }));
  if (!body.apiKey) return c.json(err("apiKey is required"), 400);
  try { return c.json(ok(await addApiKeyAccount(body.apiKey, body.label)), 201); }
  catch (e) { return c.json(err((e as Error).message), 400); }
});

/** Begin ChatGPT device-code login → returns { id, userCode, verificationUrl }. */
codexAccountsRoutes.post("/device-login", async (c) => {
  const body = await c.req.json<{ label?: string }>().catch(() => ({} as { label?: string }));
  try { return c.json(ok(await startDeviceLogin(body.label))); }
  catch (e) { return c.json(err((e as Error).message), 400); }
});

/** Poll a device login. Answers immediately: holding the connection open for the
 * whole authorization made a dropped socket look like a failed login. */
codexAccountsRoutes.get("/device-login/:id/status", (c) => c.json(ok(getDeviceLoginStatus(c.req.param("id")))));

/** Abandon a device login the user closed out of. */
codexAccountsRoutes.delete("/device-login/:id", (c) => {
  cancelDeviceLogin(c.req.param("id"));
  return c.json(ok({ cancelled: true }));
});

/** Download a password-encrypted backup of codex accounts (auth.json + apiKey creds). */
codexAccountsRoutes.post("/export", async (c) => {
  const body = await c.req.json<{ password?: string; accountIds?: string[] }>().catch(() => ({} as { password?: string; accountIds?: string[] }));
  if (!body.password) return c.json(err("Password required"), 400);
  try {
    const blob = exportCodexEncrypted(body.password, body.accountIds);
    c.header("Content-Disposition", "attachment; filename=ppm-codex-accounts-backup.json");
    c.header("Content-Type", "application/json");
    return c.body(blob);
  } catch (e) { return c.json(err((e as Error).message), 400); }
});

/** Restore codex accounts from a password-encrypted backup. */
codexAccountsRoutes.post("/import", async (c) => {
  const body = await c.req.json<{ data?: string; password?: string }>().catch(() => ({} as { data?: string; password?: string }));
  if (!body.data) return c.json(err("Backup data required"), 400);
  if (!body.password) return c.json(err("Password required"), 400);
  try { return c.json(ok(importCodexEncrypted(body.data, body.password))); }
  catch (e) { return c.json(err((e as Error).message), 400); }
});

codexAccountsRoutes.delete("/:id", (c) => {
  removeCodexAccount(c.req.param("id"));
  return c.json(ok({ removed: true }));
});
