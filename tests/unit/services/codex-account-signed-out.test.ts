import { describe, it, expect, beforeEach } from "bun:test";
import {
  createCodexAccount, removeCodexAccount, listCodexAccounts,
  selectCodexAccount, resolveCodexAccountForSession, peekCodexAccount,
  setCodexAccountStatus, CodexSignedOutError,
} from "../../../src/services/codex-account.service.ts";
import { setSessionCodexAccount } from "../../../src/services/db.service.ts";
import {
  markCodexAccountAuthFailed, isCodexAccountAuthFailed, clearCodexAccountAuthFailure,
  _resetCodexAuthFailuresForTesting,
} from "../../../src/services/codex-account-auth-state.ts";
import { _resetCodexCooldownsForTesting } from "../../../src/services/codex-account-cooldown.ts";

const mk = (label: string) => createCodexAccount({ label, type: "apiKey", creds: { type: "apiKey", apiKey: "k-" + label } });

describe("signed-out codex accounts", () => {
  beforeEach(() => {
    for (const a of listCodexAccounts()) removeCodexAccount(a.id);
    _resetCodexAuthFailuresForTesting();
    _resetCodexCooldownsForTesting();
  });

  it("marks and clears", () => {
    const a = mk("A");
    expect(isCodexAccountAuthFailed(a.id)).toBe(false);
    markCodexAccountAuthFailed(a.id, "401 Unauthorized");
    expect(isCodexAccountAuthFailed(a.id)).toBe(true);
    clearCodexAccountAuthFailure(a.id);
    expect(isCodexAccountAuthFailed(a.id)).toBe(false);
  });

  it("is never selected while another account is signed in", () => {
    const a = mk("A"); const b = mk("B");
    markCodexAccountAuthFailed(a.id, "401");
    const picks = [0, 1, 2, 3].map(() => selectCodexAccount({ strategy: "round-robin" })!.id);
    expect(new Set(picks)).toEqual(new Set([b.id]));
    expect(peekCodexAccount()?.id).toBe(b.id);
  });

  it("wins over stale usage that makes it look emptiest", () => {
    // The usage endpoint keeps serving a signed-out account's last good reading, which is
    // how a revoked team account at a stale 43% kept beating a working one at 98%.
    const a = mk("A"); const b = mk("B");
    markCodexAccountAuthFailed(a.id, "401");
    const usageOf = (id: string) => (id === a.id ? 0.43 : 0.98);
    expect(selectCodexAccount({ strategy: "lowest-usage", usageOf })?.id).toBe(b.id);
  });

  it("releases a session bound to it", async () => {
    const a = mk("A"); const b = mk("B");
    setSessionCodexAccount("sid-signed-out", a.id);
    markCodexAccountAuthFailed(a.id, "401");
    expect((await resolveCodexAccountForSession("sid-signed-out"))?.id).toBe(b.id);
  });

  it("fails fast, naming the account, when every enabled account is signed out", async () => {
    const a = mk("team");
    markCodexAccountAuthFailed(a.id, "401");
    const err = await resolveCodexAccountForSession("s").catch((e) => e);
    expect(err).toBeInstanceOf(CodexSignedOutError);
    expect((err as Error).message).toContain("team");
  });

  it("does not throw when the only other account is merely switched off", async () => {
    const a = mk("A"); const b = mk("B");
    setCodexAccountStatus(b.id, "disabled");
    expect((await resolveCodexAccountForSession("s"))?.id).toBe(a.id);
  });
});
