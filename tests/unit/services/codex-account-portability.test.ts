import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  createCodexAccount, removeCodexAccount, listCodexAccounts,
  getCodexAccount, getCodexAccountCreds, codexAccountHome,
} from "../../../src/services/codex-account.service.ts";
import { exportCodexEncrypted, importCodexEncrypted } from "../../../src/services/codex-account-portability.ts";

function clearAll() { for (const a of listCodexAccounts()) removeCodexAccount(a.id); }

describe("codex account export/import", () => {
  beforeEach(clearAll);

  it("round-trips an apiKey account (creds + auth.json) under a password", () => {
    const acct = createCodexAccount({ label: "Key A", type: "apiKey", creds: { type: "apiKey", apiKey: "sk-secret" } });
    writeFileSync(join(acct.home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-secret" }), { mode: 0o600 });

    const blob = exportCodexEncrypted("pw");
    removeCodexAccount(acct.id);
    expect(getCodexAccount(acct.id)).toBeNull();

    const res = importCodexEncrypted(blob, "pw");
    expect(res).toEqual({ imported: 1, skipped: 0 });

    const restored = getCodexAccount(acct.id);
    expect(restored?.label).toBe("Key A");
    expect(getCodexAccountCreds(acct.id)).toEqual({ type: "apiKey", apiKey: "sk-secret" });
    const authPath = join(codexAccountHome(acct.id), "auth.json");
    expect(existsSync(authPath)).toBe(true);
    expect(JSON.parse(readFileSync(authPath, "utf8")).OPENAI_API_KEY).toBe("sk-secret");
  });

  it("skips accounts that already exist (no clobber)", () => {
    const acct = createCodexAccount({ label: "Dup", type: "apiKey", creds: { type: "apiKey", apiKey: "k1" } });
    const blob = exportCodexEncrypted("pw"); // account still present
    const res = importCodexEncrypted(blob, "pw");
    expect(res).toEqual({ imported: 0, skipped: 1 });
    expect(getCodexAccount(acct.id)?.label).toBe("Dup");
  });

  it("wrong password fails to decrypt", () => {
    createCodexAccount({ label: "X", type: "apiKey", creds: { type: "apiKey", apiKey: "k" } });
    const blob = exportCodexEncrypted("right");
    expect(() => importCodexEncrypted(blob, "wrong")).toThrow();
  });

  it("empty store exports an importable (no-op) bundle", () => {
    const blob = exportCodexEncrypted("pw");
    expect(importCodexEncrypted(blob, "pw")).toEqual({ imported: 0, skipped: 0 });
  });
});
