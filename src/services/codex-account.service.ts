/**
 * Codex multi-account store. Each account owns a CODEX_HOME dir
 * (`<ppmDir>/codex-accounts/<id>/`) where the codex app-server writes its
 * auth.json. Credentials (apiKey / chatgpt tokens) are encrypted at rest with
 * the shared ~/.ppm/account.key scheme (reused from the Claude account system).
 *
 * Login orchestration (P2), per-session selection (P3) and usage (P4) build on
 * this store.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { getDb, getSessionCodexAccount } from "./db.service.ts";
import { getPpmDir } from "./ppm-dir.ts";
import { configService } from "./config.service.ts";
import { encrypt, decrypt } from "../lib/account-crypto.ts";
import { fetchCodexUsage } from "../providers/codex-app-server/codex-usage-fetch.ts";
import type { UsageInfo } from "../providers/provider.interface.ts";

export type CodexStrategy = "round-robin" | "fill-first" | "lowest-usage";

export type CodexAccountType = "apiKey" | "chatgpt";

export interface CodexAccount {
  id: string;
  label: string;
  type: CodexAccountType;
  home: string;
  planType?: string | null;
  addedAt: string;
}

/** Credentials persisted (encrypted) per account, replayed into a fresh home on login. */
export type CodexCreds =
  | { type: "apiKey"; apiKey: string }
  | { type: "chatgpt"; accessToken: string; chatgptAccountId: string; planType?: string | null };

interface Row {
  id: string; label: string | null; type: string; home: string;
  plan_type: string | null; creds_enc: string | null; added_at: string;
}

function rowToAccount(r: Row): CodexAccount {
  return { id: r.id, label: r.label ?? r.id.slice(0, 8), type: r.type as CodexAccountType, home: r.home, planType: r.plan_type, addedAt: r.added_at };
}

/** CODEX_HOME directory for an account id. */
export function codexAccountHome(id: string): string {
  return resolve(getPpmDir(), "codex-accounts", id);
}

export function listCodexAccounts(): CodexAccount[] {
  const rows = getDb().query("SELECT * FROM codex_accounts ORDER BY added_at ASC").all() as Row[];
  return rows.map(rowToAccount);
}

export function getCodexAccount(id: string): CodexAccount | null {
  const r = getDb().query("SELECT * FROM codex_accounts WHERE id = ?").get(id) as Row | null;
  return r ? rowToAccount(r) : null;
}

/** Decrypt and return the stored credentials for an account (null if absent). */
export function getCodexAccountCreds(id: string): CodexCreds | null {
  const r = getDb().query("SELECT creds_enc FROM codex_accounts WHERE id = ?").get(id) as { creds_enc: string | null } | null;
  if (!r?.creds_enc) return null;
  try { return JSON.parse(decrypt(r.creds_enc)) as CodexCreds; } catch { return null; }
}

/**
 * Create an account row + its CODEX_HOME dir. Caller (P2 login) supplies the
 * verified label/planType and the creds to persist (encrypted). Idempotent dir create.
 */
export function createCodexAccount(input: {
  label: string; type: CodexAccountType; planType?: string | null; creds?: CodexCreds; id?: string;
}): CodexAccount {
  const id = input.id ?? randomUUID();
  const home = codexAccountHome(id);
  // 0700: the home holds auth.json (live tokens) — keep it owner-only on POSIX.
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // chatgpt tokens live (refreshable) in the home's auth.json — only apiKey is
  // worth persisting separately (cheap re-login if the home is lost).
  const credsEnc = input.creds ? encrypt(JSON.stringify(input.creds)) : null;
  try {
    getDb().query(
      "INSERT INTO codex_accounts (id, label, type, home, plan_type, creds_enc) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, input.label, input.type, home, input.planType ?? null, credsEnc);
  } catch (e) {
    // Keep the invariant row⟺home: drop the dir if the row didn't land.
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
    throw e;
  }
  return getCodexAccount(id)!;
}

/** Update label/plan after a (re)login verification. */
export function updateCodexAccountMeta(id: string, meta: { label?: string; planType?: string | null }): void {
  const sets: string[] = []; const vals: unknown[] = [];
  if (meta.label !== undefined) { sets.push("label = ?"); vals.push(meta.label); }
  if (meta.planType !== undefined) { sets.push("plan_type = ?"); vals.push(meta.planType); }
  if (sets.length === 0) return;
  vals.push(id);
  getDb().query(`UPDATE codex_accounts SET ${sets.join(", ")} WHERE id = ?`).run(...vals as any[]);
}

/** Remove the account row and its CODEX_HOME dir. */
export function removeCodexAccount(id: string): void {
  const acct = getCodexAccount(id);
  getDb().query("DELETE FROM codex_accounts WHERE id = ?").run(id);
  if (acct) { try { rmSync(acct.home, { recursive: true, force: true }); } catch { /* ignore */ } }
}

// ── Selection ──
let rrIndex = 0;

export function getCodexStrategy(): CodexStrategy {
  try {
    const s = (configService.get("ai").providers["codex"] as { account_strategy?: CodexStrategy } | undefined)?.account_strategy;
    return s ?? "round-robin";
  } catch { return "round-robin"; }
}

export function setCodexStrategy(strategy: CodexStrategy): void {
  const ai = configService.get("ai");
  const codex = { ...(ai.providers["codex"] ?? { type: "cli", cli_command: "codex" }), account_strategy: strategy };
  configService.set("ai", { ...ai, providers: { ...ai.providers, codex } });
  configService.save();
}

/**
 * Pick an account by strategy. `usageOf` (optional, from P4) enables lowest-usage;
 * without it lowest-usage falls back to round-robin.
 */
export function selectCodexAccount(opts?: { strategy?: CodexStrategy; usageOf?: (id: string) => number }): CodexAccount | null {
  const accts = listCodexAccounts();
  if (accts.length === 0) return null;
  if (accts.length === 1) return accts[0]!;
  const strategy = opts?.strategy ?? getCodexStrategy();
  const usageOf = opts?.usageOf;
  if (strategy === "fill-first") return accts[0]!;
  if (strategy === "lowest-usage" && usageOf) {
    return accts.reduce((best, a) => (usageOf(a.id) < usageOf(best.id) ? a : best), accts[0]!);
  }
  const pick = accts[rrIndex % accts.length]!;
  rrIndex++;
  return pick;
}

/** Sticky account for a session → else strategy pick → else null (default ~/.codex). */
export async function resolveCodexAccountForSession(sessionId: string): Promise<CodexAccount | null> {
  const sticky = getSessionCodexAccount(sessionId);
  if (sticky) { const a = getCodexAccount(sticky); if (a) return a; }
  if (getCodexStrategy() === "lowest-usage" && listCodexAccounts().length > 1) {
    const usages = await getAllCodexUsages();
    // A failed usage fetch (broken/expired account) yields {} → treat as +Infinity
    // so lowest-usage de-prioritizes it instead of preferring it as "0% used".
    return selectCodexAccount({ strategy: "lowest-usage", usageOf: (id) => usages[id]?.fiveHour ?? Number.POSITIVE_INFINITY });
  }
  return selectCodexAccount();
}

// ── Usage (per account) ──
export async function getCodexAccountUsage(id: string): Promise<UsageInfo> {
  const a = getCodexAccount(id);
  return a ? fetchCodexUsage(a.home) : {};
}

export async function getAllCodexUsages(): Promise<Record<string, UsageInfo>> {
  const accts = listCodexAccounts();
  const entries = await Promise.all(accts.map(async (a) => [a.id, await fetchCodexUsage(a.home)] as const));
  return Object.fromEntries(entries);
}
