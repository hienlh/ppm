/**
 * Codex account export/import (parity with the Claude accounts backup).
 * The portable unit per account is its CODEX_HOME `auth.json` (the live
 * codex-managed auth) plus any stored apiKey creds. The bundle is encrypted
 * with a user password (PBKDF2 + AES, shared `encryptWithPassword` scheme) so
 * accounts can move between machines.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { encryptWithPassword, decryptWithPassword } from "../lib/account-crypto.ts";
import {
  listCodexAccounts, getCodexAccount, getCodexAccountCreds, codexAccountHome,
  createCodexAccount, type CodexAccount, type CodexAccountType, type CodexCreds,
} from "./codex-account.service.ts";

const BACKUP_MAGIC = "ppm-codex-accounts-backup";

interface PortableCodexAccount {
  id: string;
  label: string;
  type: CodexAccountType;
  planType?: string | null;
  authJson?: string | null; // contents of CODEX_HOME/auth.json
  creds?: CodexCreds | null; // apiKey creds (chatgpt auth lives in authJson)
}

/** Password-encrypted backup blob of all (or selected) codex accounts. */
export function exportCodexEncrypted(password: string, accountIds?: string[]): string {
  const accts = accountIds?.length
    ? (accountIds.map(getCodexAccount).filter(Boolean) as CodexAccount[])
    : listCodexAccounts();
  const portable: PortableCodexAccount[] = accts.map((a) => {
    let authJson: string | null = null;
    try {
      const authPath = join(a.home, "auth.json");
      if (existsSync(authPath)) authJson = readFileSync(authPath, "utf8");
    } catch { /* ignore unreadable home */ }
    return { id: a.id, label: a.label, type: a.type, planType: a.planType ?? null, authJson, creds: getCodexAccountCreds(a.id) };
  });
  return encryptWithPassword(JSON.stringify({ magic: BACKUP_MAGIC, accounts: portable }), password);
}

/** Restore codex accounts from a password-encrypted backup. Skips ids that already exist. */
export function importCodexEncrypted(blob: string, password: string): { imported: number; skipped: number } {
  const plaintext = decryptWithPassword(blob, password);
  const parsed = JSON.parse(plaintext) as { magic?: string; accounts?: PortableCodexAccount[] };
  const accounts = parsed?.accounts;
  if (!Array.isArray(accounts)) throw new Error("Invalid codex backup format");

  let imported = 0;
  let skipped = 0;
  for (const p of accounts) {
    if (!p.id || !p.type) { skipped++; continue; }
    if (getCodexAccount(p.id)) { skipped++; continue; } // already present — don't clobber

    // createCodexAccount inserts the row and mkdirs the CODEX_HOME (0700).
    createCodexAccount({
      id: p.id, label: p.label || "Imported", type: p.type,
      planType: p.planType ?? null, creds: p.creds ?? undefined,
    });

    // Restore auth.json so codex re-auths from it on next spawn.
    if (p.authJson) {
      try {
        const home = codexAccountHome(p.id);
        mkdirSync(home, { recursive: true, mode: 0o700 });
        writeFileSync(join(home, "auth.json"), p.authJson, { mode: 0o600 });
      } catch { /* ignore — apiKey accounts can still re-login from creds */ }
    }
    imported++;
  }
  return { imported, skipped };
}
