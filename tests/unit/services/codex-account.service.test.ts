import { describe, it, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareAssistantCodexHome } from "../../../src/providers/codex-app-server/codex-assistant-home.ts";
import {
  createCodexAccount, listCodexAccounts, getCodexAccount,
  getCodexAccountCreds, removeCodexAccount, updateCodexAccountMeta,
  setCodexDailyGuard,
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
    expect(acct.dailyGuardEnabled).toBe(true);

    // encrypted at rest: the raw secret must not appear in the stored column
    const row = getDb().query("SELECT creds_enc FROM codex_accounts WHERE id = ?").get(acct.id) as { creds_enc: string };
    expect(row.creds_enc).not.toContain("sk-secret-ABC123");

    updateCodexAccountMeta(acct.id, { label: "renamed", planType: "pro" });
    expect(getCodexAccount(acct.id)?.label).toBe("renamed");
    expect(getCodexAccount(acct.id)?.planType).toBe("pro");

    expect(setCodexDailyGuard(acct.id, false)?.dailyGuardEnabled).toBe(false);

    removeCodexAccount(acct.id);
    expect(getCodexAccount(acct.id)).toBeNull();
    expect(existsSync(acct.home)).toBe(false);
  });

  it("remove deletes the Assistant's home for the account at once, never through its sessions link", () => {
    const acct = createCodexAccount({ label: "assistant", type: "apiKey", planType: null, creds: { type: "apiKey", apiKey: "sk-x" } });
    writeFileSync(join(acct.home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-x" }));
    mkdirSync(join(acct.home, "sessions"), { recursive: true });
    const prepared = prepareAssistantCodexHome(acct.home);
    if (!prepared.home) throw new Error(`not prepared: ${prepared.reason}`);
    const home = prepared.home;

    // Repoint the link at a folder that outlives the account: a delete that walked through it
    // would empty that folder.
    const keep = mkdtempSync(join(tmpdir(), "ppm-codex-keep-"));
    try {
      writeFileSync(join(keep, "rollout-keep.jsonl"), "{}\n");
      unlinkSync(join(home, "sessions"));
      symlinkSync(keep, join(home, "sessions"), process.platform === "win32" ? "junction" : "dir");

      removeCodexAccount(acct.id);
      expect(existsSync(home)).toBe(false);
      expect(existsSync(acct.home)).toBe(false);
      expect(existsSync(join(keep, "rollout-keep.jsonl"))).toBe(true);
    } finally {
      rmSync(keep, { recursive: true, force: true });
    }
  });

  it("getCreds returns null for unknown id", () => {
    expect(getCodexAccountCreds("nope")).toBeNull();
    expect(getCodexAccount("nope")).toBeNull();
  });
});
