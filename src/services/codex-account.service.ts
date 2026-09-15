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
import { getOrFetchUsage } from "./provider-usage/usage-registry.ts";
import type { UsageInfo } from "../providers/provider.interface.ts";

export type CodexStrategy = "round-robin" | "fill-first" | "lowest-usage";

export type CodexAccountType = "apiKey" | "chatgpt";

/** Two states only — nothing here parks an account in cooldown the way Claude's rotation does. */
export type CodexAccountStatus = "active" | "disabled";

export interface CodexAccount {
  id: string;
  label: string;
  type: CodexAccountType;
  home: string;
  planType?: string | null;
  status: CodexAccountStatus;
  addedAt: string;
}

/** Credentials persisted (encrypted) per account, replayed into a fresh home on login. */
export type CodexCreds =
  | { type: "apiKey"; apiKey: string }
  | { type: "chatgpt"; accessToken: string; chatgptAccountId: string; planType?: string | null };

interface Row {
  id: string; label: string | null; type: string; home: string;
  plan_type: string | null; creds_enc: string | null; added_at: string;
  status?: string | null;
}

function rowToAccount(r: Row): CodexAccount {
  return {
    id: r.id,
    label: r.label ?? r.id.slice(0, 8),
    type: r.type as CodexAccountType,
    home: r.home,
    planType: r.plan_type,
    // A row written before the column existed reads as null; treat that as enabled, which
    // is what it effectively was.
    status: r.status === "disabled" ? "disabled" : "active",
    addedAt: r.added_at,
  };
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

/**
 * Switch an account on or off.
 *
 * Deliberately no token proof on the way in, unlike the Claude path: that check exists
 * because an Anthropic OAuth account can hold a refresh token the server has to exercise
 * before trusting. A Codex account is a CODEX_HOME directory the app-server authenticates
 * against when it spawns, so there is nothing here to prove in advance — copying that check
 * across would buy a slow button and no safety.
 *
 * Disabling never touches credentials. Off and removed are different things, and the account
 * has to come back exactly as it was.
 */
export function setCodexAccountStatus(id: string, status: CodexAccountStatus): CodexAccount | null {
  if (!getCodexAccount(id)) return null;
  getDb().query("UPDATE codex_accounts SET status = ? WHERE id = ?").run(status, id);
  return getCodexAccount(id);
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

/** Five-hour utilisation at or above which an account is skipped while others have room. */
const FIVE_HOUR_SKIP_THRESHOLD = 0.95;

/**
 * Drop accounts with no five-hour room left, unless that would leave nothing.
 *
 * Soft on purpose, mirroring the Claude selector: a throttled turn beats no turn, so when
 * every account is at its cap the caller still gets one back. `usageOf` is supplied by the
 * caller rather than fetched here — usage lives behind an async provider layer, and pulling
 * it inside a synchronous pick would put a network round-trip on every account selection.
 * With no `usageOf` there is nothing to judge and every account stays a candidate.
 */
function withFiveHourRoom(
  accts: CodexAccount[],
  usageOf?: (id: string) => number,
): CodexAccount[] {
  if (!usageOf) return accts;
  const room = accts.filter((a) => {
    const util = usageOf(a.id);
    return !Number.isFinite(util) ? true : util < FIVE_HOUR_SKIP_THRESHOLD;
  });
  return room.length > 0 ? room : accts;
}

/**
 * Pick an account by strategy. `usageOf` (optional, from P4) enables lowest-usage;
 * without it lowest-usage falls back to round-robin.
 *
 * `usageOf` also drives the five-hour skip, so a caller that supplies it gets an account
 * with room rather than merely the least-used one among several that are all capped.
 */
export function selectCodexAccount(opts?: { strategy?: CodexStrategy; usageOf?: (id: string) => number }): CodexAccount | null {
  // Disabled is a hard exclusion with no fallback, unlike the five-hour skip below. Being
  // capped means a slower turn; being switched off is the user saying don't use this, and
  // handing it back anyway because nothing else was left would ignore them.
  const all = listCodexAccounts().filter((a) => a.status !== "disabled");
  if (all.length === 0) return null;
  if (all.length === 1) return all[0]!;
  const strategy = opts?.strategy ?? getCodexStrategy();
  const usageOf = opts?.usageOf;
  const accts = withFiveHourRoom(all, usageOf);
  if (accts.length === 1) return accts[0]!;
  if (strategy === "fill-first") return accts[0]!;
  if (strategy === "lowest-usage" && usageOf) {
    return accts.reduce((best, a) => (usageOf(a.id) < usageOf(best.id) ? a : best), accts[0]!);
  }
  const pick = accts[rrIndex % accts.length]!;
  rrIndex++;
  return pick;
}

/**
 * The account that WILL serve a session with no binding yet, when that is
 * knowable without side effects — otherwise null.
 *
 * Exists so the chat toolbar can name the account before the first message
 * instead of showing a blank where the account belongs. It deliberately does
 * not call `selectCodexAccount`: round-robin advances a cursor, so asking it
 * merely to draw a label would change which account the next real turn gets.
 *
 * Certain in exactly two cases — a single account, and `fill-first`, which
 * always takes the oldest. Round-robin and lowest-usage across several
 * accounts are genuinely undecided until the turn starts, and this returns
 * null rather than guessing at one.
 */
export function peekCodexAccount(): CodexAccount | null {
  // Status is the one thing this can filter on without going async, so it does. Usage lives
  // behind a fetch and stays out of reach here; the consuming pick endpoint reads it instead.
  const accts = listCodexAccounts().filter((a) => a.status !== "disabled");
  if (accts.length === 0) return null;
  if (accts.length === 1) return accts[0]!;
  return getCodexStrategy() === "fill-first" ? accts[0]! : null;
}

/** Sticky account for a session → else strategy pick → else null (default ~/.codex). */
export async function resolveCodexAccountForSession(sessionId?: string): Promise<CodexAccount | null> {
  // Session-less callers (the model list) have nothing sticky to honour and fall
  // straight through to the configured strategy.
  const sticky = sessionId ? getSessionCodexAccount(sessionId) : null;
  // A binding is held for the prompt cache, not honoured unconditionally: an account the
  // user has switched off has to let go of the sessions sitting on it, or turning it off
  // would do nothing for exactly the conversations already using it.
  if (sticky) { const a = getCodexAccount(sticky); if (a && a.status !== "disabled") return a; }
  if (listCodexAccounts().filter((a) => a.status !== "disabled").length <= 1) return selectCodexAccount();
  // Usage is read for every strategy, not just lowest-usage: it is also what lets the
  // selector skip an account with no five-hour room left. Reading it only for lowest-usage
  // left that skip inert under round-robin, which is the default — sessions kept landing on
  // accounts that were already capped. The read is served from the shared usage cache, so
  // this costs a lookup rather than a request per session start.
  //
  // A failed usage fetch (broken/expired account) yields {} → treat as +Infinity so
  // lowest-usage de-prioritizes it instead of preferring it as "0% used".
  const usages = await getAllCodexUsages();
  return selectCodexAccount({ usageOf: (id) => usages[id]?.fiveHour ?? Number.POSITIVE_INFINITY });
}

// ── Usage (per account) ──
// Both read through the shared provider-usage layer, so the accounts screen is
// served from the same cache and snapshot store as the chat toolbar and cannot
// spawn one app-server per listed account on every render.
export async function getCodexAccountUsage(id: string): Promise<UsageInfo> {
  return getCodexAccount(id) ? getOrFetchUsage("codex", id) : {};
}

export async function getAllCodexUsages(): Promise<Record<string, UsageInfo>> {
  const accts = listCodexAccounts();
  const entries = await Promise.all(accts.map(async (a) => [a.id, await getOrFetchUsage("codex", a.id)] as const));
  return Object.fromEntries(entries);
}
