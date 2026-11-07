/**
 * Antigravity multi-account store.
 *
 * - The ambient IDE/CLI account (`id: "default"`, `home: ""`) represents the primary
 *   Antigravity Desktop / OS keyring login in `~/.gemini`.
 * - Each additional account owns an isolated home directory (`<ppmDir>/antigravity-accounts/<id>`)
 *   and runs with `HOME=<account.home>` and `WSL_DISTRO_NAME=ppm`, storing its OAuth token in
 *   `<account.home>/.gemini/jetski-standalone-oauth-token`.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { getDb, getSessionAccount, setSessionAccount } from "./db.service.ts";
import { getPpmDir } from "./ppm-dir.ts";
import { configService } from "./config.service.ts";
import { getOrFetchUsage } from "./provider-usage/usage-registry.ts";
import {
  discoverLanguageServerConnection,
  stopManagedLanguageServer,
} from "../providers/antigravity/antigravity-connection.ts";
import { fetchAntigravityAccountStatus } from "../providers/antigravity/antigravity-usage.ts";
import type { UsageInfo } from "../providers/provider.interface.ts";

export const DEFAULT_ANTIGRAVITY_ACCOUNT_ID = "default";

export type AntigravityStrategy = "round-robin" | "fill-first" | "lowest-usage";
export type AntigravityAccountStatus = "active" | "disabled";

export interface AntigravityAccount {
  id: string;
  label: string;
  email?: string | null;
  planType?: string | null;
  /** `""` for the ambient IDE account (`~/.gemini`), or `<ppmDir>/antigravity-accounts/<id>` for isolated accounts. */
  home: string;
  status: AntigravityAccountStatus;
  addedAt: string;
}

interface Row {
  id: string;
  label: string | null;
  email: string | null;
  plan_type: string | null;
  home: string;
  status: string | null;
  added_at: string;
}

function ensureTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS antigravity_accounts (
      id TEXT PRIMARY KEY,
      label TEXT,
      email TEXT,
      plan_type TEXT,
      home TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      added_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function rowToAccount(r: Row): AntigravityAccount {
  return {
    id: r.id,
    label: r.label ?? r.email ?? r.id.slice(0, 8),
    email: r.email,
    planType: r.plan_type,
    home: r.home,
    status: r.status === "disabled" ? "disabled" : "active",
    addedAt: r.added_at,
  };
}

/** Isolated home directory for a non-default Antigravity account id. */
export function antigravityAccountHome(id: string): string {
  if (id === DEFAULT_ANTIGRAVITY_ACCOUNT_ID) return "";
  return resolve(getPpmDir(), "antigravity-accounts", id);
}

/** Format an account's display label with its plan badge for the chat toolbar. */
export function formatAntigravityAccountLabel(account: Pick<AntigravityAccount, "label" | "planType">): string {
  return account.planType ? `${account.label} · ${account.planType}` : account.label;
}

export function listAntigravityAccounts(): AntigravityAccount[] {
  ensureTable();
  const rows = getDb()
    .query("SELECT * FROM antigravity_accounts ORDER BY CASE WHEN id = 'default' THEN 0 ELSE 1 END, added_at ASC")
    .all() as Row[];
  return rows.map(rowToAccount);
}

export function getAntigravityAccount(id: string): AntigravityAccount | null {
  ensureTable();
  const r = getDb().query("SELECT * FROM antigravity_accounts WHERE id = ?").get(id) as Row | null;
  return r ? rowToAccount(r) : null;
}

/**
 * Sync the ambient Antigravity Desktop / CLI login (`id: "default"`, `home: ""`) into the
 * account pool when the local Language Server is running, so the user's primary IDE login
 * appears alongside any additional accounts.
 */
let lastDefaultSyncAt = 0;
let lastDefaultSyncHome = "";
const DEFAULT_SYNC_TTL_MS = 30_000;

export async function syncDefaultAntigravityAccount(): Promise<AntigravityAccount | null> {
  ensureTable();
  const currentHome = process.env.HOME ?? "";
  const now = Date.now();
  if (now - lastDefaultSyncAt < DEFAULT_SYNC_TTL_MS && lastDefaultSyncHome === currentHome) {
    const cached = getAntigravityAccount(DEFAULT_ANTIGRAVITY_ACCOUNT_ID);
    if (cached) return cached;
  }
  if (!discoverLanguageServerConnection()) {
    return getAntigravityAccount(DEFAULT_ANTIGRAVITY_ACCOUNT_ID);
  }
  const status = await fetchAntigravityAccountStatus().catch(() => null);
  if (!status?.connected || (!status.email && !status.name)) {
    return getAntigravityAccount(DEFAULT_ANTIGRAVITY_ACCOUNT_ID);
  }
  lastDefaultSyncAt = now;
  lastDefaultSyncHome = currentHome;
  const existing = getAntigravityAccount(DEFAULT_ANTIGRAVITY_ACCOUNT_ID);
  const label = status.name || status.email || "Antigravity Desktop";
  const email = status.email ?? null;
  const planType = status.planName ?? null;

  if (!existing) {
    getDb()
      .query(
        "INSERT INTO antigravity_accounts (id, label, email, plan_type, home, status) VALUES (?, ?, ?, ?, '', 'active')",
      )
      .run(DEFAULT_ANTIGRAVITY_ACCOUNT_ID, label, email, planType);
  } else {
    updateAntigravityAccountMeta(DEFAULT_ANTIGRAVITY_ACCOUNT_ID, {
      email: email ?? existing.email,
      planType: planType ?? existing.planType,
      label: existing.label === "Default" || existing.label === existing.email ? label : existing.label,
    });
  }
  return getAntigravityAccount(DEFAULT_ANTIGRAVITY_ACCOUNT_ID);
}

export function createAntigravityAccount(input: {
  id?: string;
  label: string;
  email?: string | null;
  planType?: string | null;
  home?: string;
}): AntigravityAccount {
  ensureTable();
  const id = input.id ?? randomUUID();
  const home = input.home !== undefined ? input.home : antigravityAccountHome(id);
  if (home) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
  }
  try {
    getDb()
      .query(
        "INSERT INTO antigravity_accounts (id, label, email, plan_type, home, status) VALUES (?, ?, ?, ?, ?, 'active')",
      )
      .run(id, input.label, input.email ?? null, input.planType ?? null, home);
  } catch (e) {
    if (home) {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    throw e;
  }
  return getAntigravityAccount(id)!;
}

export function updateAntigravityAccountMeta(
  id: string,
  meta: { label?: string; email?: string | null; planType?: string | null },
): void {
  ensureTable();
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (meta.label !== undefined) { sets.push("label = ?"); vals.push(meta.label); }
  if (meta.email !== undefined) { sets.push("email = ?"); vals.push(meta.email); }
  if (meta.planType !== undefined) { sets.push("plan_type = ?"); vals.push(meta.planType); }
  if (sets.length === 0) return;
  vals.push(id);
  getDb().query(`UPDATE antigravity_accounts SET ${sets.join(", ")} WHERE id = ?`).run(...(vals as any[]));
}

export function setAntigravityAccountStatus(
  id: string,
  status: AntigravityAccountStatus,
): AntigravityAccount | null {
  ensureTable();
  if (!getAntigravityAccount(id)) return null;
  getDb().query("UPDATE antigravity_accounts SET status = ? WHERE id = ?").run(status, id);
  if (status === "active") clearAntigravityAccountAuthFailure(id);
  return getAntigravityAccount(id);
}

export function removeAntigravityAccount(id: string): void {
  ensureTable();
  const acct = getAntigravityAccount(id);
  getDb().query("DELETE FROM antigravity_accounts WHERE id = ?").run(id);
  clearAntigravityAccountAuthFailure(id);
  if (acct?.home) {
    stopManagedLanguageServer(acct.home);
    try { rmSync(acct.home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── Auth-failure state (in-memory, mirroring codex-account-auth-state.ts) ──

const AUTH_FAIL_TTL_MS = 15 * 60 * 1000;
const authFailures = new Map<string, { until: number; reason: string; since: number }>();

export function markAntigravityAccountAuthFailed(accountId: string, reason: string): void {
  const now = Date.now();
  const prev = authFailures.get(accountId);
  const fresh = !prev || prev.until <= now;
  authFailures.set(accountId, { until: now + AUTH_FAIL_TTL_MS, reason, since: fresh ? now : prev.since });
}

export function isAntigravityAccountAuthFailed(accountId: string): boolean {
  const f = authFailures.get(accountId);
  if (!f) return false;
  if (f.until <= Date.now()) {
    authFailures.delete(accountId);
    return false;
  }
  return true;
}

export function clearAntigravityAccountAuthFailure(accountId: string): void {
  authFailures.delete(accountId);
}

export function _resetAntigravityAuthFailuresForTesting(): void {
  authFailures.clear();
}

// ── Selection ──

let rrIndex = 0;
const FIVE_HOUR_SKIP_THRESHOLD = 0.95;

export function getAntigravityStrategy(): AntigravityStrategy {
  try {
    const s = (
      configService.get("ai").providers["antigravity"] as { account_strategy?: AntigravityStrategy } | undefined
    )?.account_strategy;
    return s ?? "round-robin";
  } catch {
    return "round-robin";
  }
}

export function setAntigravityStrategy(strategy: AntigravityStrategy): void {
  const ai = configService.get("ai");
  const antigravity = {
    ...(ai.providers["antigravity"] ?? { type: "cli" as const }),
    account_strategy: strategy,
  };
  configService.set("ai", { ...ai, providers: { ...ai.providers, antigravity } });
  configService.save();
}

export function antigravityUsageLevel(usage?: UsageInfo): number {
  return usage?.fiveHour ?? usage?.sevenDay ?? Number.POSITIVE_INFINITY;
}

function servableAccounts(): AntigravityAccount[] {
  return listAntigravityAccounts().filter(
    (a) => a.status !== "disabled" && !isAntigravityAccountAuthFailed(a.id),
  );
}

function withFiveHourRoom(
  accts: AntigravityAccount[],
  usageOf?: (id: string) => number,
): AntigravityAccount[] {
  if (!usageOf) return accts;
  const room = accts.filter((a) => {
    const util = usageOf(a.id);
    return !Number.isFinite(util) ? true : util < FIVE_HOUR_SKIP_THRESHOLD;
  });
  return room.length > 0 ? room : accts;
}

export function selectAntigravityAccount(opts?: {
  strategy?: AntigravityStrategy;
  usageOf?: (id: string) => number;
  exclude?: string[];
}): AntigravityAccount | null {
  const excluded = new Set(opts?.exclude ?? []);
  const all = servableAccounts().filter((a) => !excluded.has(a.id));
  if (all.length === 0) return null;
  if (all.length === 1) return all[0]!;
  const strategy = opts?.strategy ?? getAntigravityStrategy();
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

export function peekAntigravityAccount(): AntigravityAccount | null {
  const accts = servableAccounts();
  if (accts.length === 0) return null;
  if (accts.length === 1) return accts[0]!;
  return getAntigravityStrategy() === "fill-first" ? accts[0]! : null;
}

/** Resolve sticky account for a session, or pick one via strategy and bind it. */
export async function resolveAntigravityAccountForSession(
  sessionId?: string,
): Promise<AntigravityAccount | null> {
  const sticky = sessionId ? getSessionAccount(sessionId) : null;
  if (sticky) {
    const a = getAntigravityAccount(sticky);
    if (a && a.status !== "disabled" && !isAntigravityAccountAuthFailed(a.id)) return a;
  }
  const usable = servableAccounts();
  if (usable.length === 0) return null;
  let picked: AntigravityAccount | null;
  if (usable.length === 1) {
    picked = usable[0]!;
  } else {
    const usages = await getAllAntigravityUsages();
    picked = selectAntigravityAccount({ usageOf: (id) => antigravityUsageLevel(usages[id]) });
  }
  if (picked && sessionId) {
    try { setSessionAccount(sessionId, picked.id); } catch { /* ignore */ }
  }
  return picked;
}

// ── Per-account Usage ──

export async function getAntigravityAccountUsage(id: string): Promise<UsageInfo> {
  const acct = getAntigravityAccount(id);
  if (!acct) return {};
  const usage = await getOrFetchUsage("antigravity", id);
  return {
    ...usage,
    activeAccountId: acct.id,
    activeAccountLabel: formatAntigravityAccountLabel(acct),
  };
}

export async function getAllAntigravityUsages(): Promise<Record<string, UsageInfo>> {
  const accts = listAntigravityAccounts();
  const entries = await Promise.all(
    accts.map(async (a) => [a.id, await getAntigravityAccountUsage(a.id)] as const),
  );
  return Object.fromEntries(entries);
}
