import { describe, it, expect } from "bun:test";
import { existsSync } from "node:fs";
import {
  createCodexAccount, listCodexAccounts, getCodexAccount,
  getCodexAccountCreds, removeCodexAccount, updateCodexAccountMeta,
} from "../../../src/services/codex-account.service.ts";
import { getDb } from "../../../src/services/db.service.ts";

describe("codex-account.service", () => {
  it("create → list → get → creds round-trip, encrypted at rest, remove cleans home", () => {
    const acct = createCodexAccount({
      label: "work", type: "apiKey", planType: "plus",
      creds: { type: "apiKey", apiKey: "sk-secret-ABC123" },
    });
    expect(acct.type).toBe("apiKey");
    expect(existsSync(acct.home)).toBe(true);
    expect(listCodexAccounts().some((a) => a.id === acct.id)).toBe(true);
    expect(getCodexAccount(acct.id)?.label).toBe("work");
    expect(getCodexAccountCreds(acct.id)).toEqual({ type: "apiKey", apiKey: "sk-secret-ABC123" });

    // encrypted at rest: the raw secret must not appear in the stored column
    const row = getDb().query("SELECT creds_enc FROM codex_accounts WHERE id = ?").get(acct.id) as { creds_enc: string };
    expect(row.creds_enc).not.toContain("sk-secret-ABC123");

    updateCodexAccountMeta(acct.id, { label: "renamed", planType: "pro" });
    expect(getCodexAccount(acct.id)?.label).toBe("renamed");
    expect(getCodexAccount(acct.id)?.planType).toBe("pro");

    removeCodexAccount(acct.id);
    expect(getCodexAccount(acct.id)).toBeNull();
    expect(existsSync(acct.home)).toBe(false);
  });

  it("getCreds returns null for unknown id", () => {
    expect(getCodexAccountCreds("nope")).toBeNull();
    expect(getCodexAccount("nope")).toBeNull();
  });
});
