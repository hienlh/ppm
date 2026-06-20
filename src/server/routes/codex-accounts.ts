import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import { listCodexAccounts, removeCodexAccount, getAllCodexUsages, getCodexStrategy, setCodexStrategy, type CodexStrategy } from "../../services/codex-account.service.ts";
import { addApiKeyAccount, startDeviceLogin, awaitDeviceLogin } from "../../services/codex-account-login.ts";

/** Codex multi-account management. Mounted under /api/codex-accounts (auth-guarded). */
export const codexAccountsRoutes = new Hono();

codexAccountsRoutes.get("/", (c) => c.json(ok({ accounts: listCodexAccounts(), strategy: getCodexStrategy() })));

/** Per-account quota map { [accountId]: UsageInfo }. */
codexAccountsRoutes.get("/usage", async (c) => c.json(ok(await getAllCodexUsages())));

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

/** Long-poll until the device login completes; persists the account on success. */
codexAccountsRoutes.post("/device-login/:id/await", async (c) => {
  try { return c.json(ok(await awaitDeviceLogin(c.req.param("id"))), 201); }
  catch (e) { return c.json(err((e as Error).message), 400); }
});

codexAccountsRoutes.delete("/:id", (c) => {
  removeCodexAccount(c.req.param("id"));
  return c.json(ok({ removed: true }));
});
