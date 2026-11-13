/**
 * An account as `ppm accounts` prints it: id, provider, label, email, status and a note — and
 * nothing else from the server's record (no profile blob, no Codex home folder). The routes carry
 * no credential, and this is the one place that decides what a command shows of an account.
 */

export type Provider = "claude" | "codex";

/** What `GET /api/accounts` answers per account (the fields read here). */
export interface ClaudeAccount {
  id: string; label: string | null; email: string | null; status: string;
  reauthRequired?: boolean; hasRefreshToken?: boolean;
}

/** What `GET /api/codex-accounts` answers per account (the fields read here). */
export interface CodexAccount { id: string; label: string; type: string; planType?: string | null; status?: string; signedOut?: boolean }

export interface AccountRow {
  id: string;
  provider: Provider;
  label: string | null;
  email: string | null;
  status: string;
  note: string | null;
}

export function accountRow(provider: Provider, a: ClaudeAccount | CodexAccount): AccountRow {
  if (provider === "claude") {
    const c = a as ClaudeAccount;
    const note = c.reauthRequired ? "sign in again" : c.hasRefreshToken === false ? "temporary (no refresh token)" : null;
    return { id: c.id, provider, label: c.label, email: c.email, status: c.status, note };
  }
  const x = a as CodexAccount;
  const kind = x.type === "apiKey" ? "API key" : x.planType ? `ChatGPT ${x.planType}` : "ChatGPT";
  return { id: x.id, provider, label: x.label, email: null, status: x.status ?? "active", note: x.signedOut ? "signed out: sign in again" : kind };
}

/** The account `idOrPrefix` names: a full id, or the unique start of one (4+ characters). */
export function findAccount(rows: AccountRow[], idOrPrefix: string): AccountRow {
  const exact = rows.find((r) => r.id === idOrPrefix);
  if (exact) return exact;
  const found = idOrPrefix.length >= 4 ? rows.filter((r) => r.id.startsWith(idOrPrefix)) : [];
  if (found.length === 1) return found[0]!;
  throw new Error(found.length > 1 ? `"${idOrPrefix}" is the start of more than one account; give more of its id` : `No account "${idOrPrefix}" (see \`ppm accounts list\`)`);
}
