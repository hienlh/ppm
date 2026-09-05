import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import { openTestDb, setDb, closeDb } from "../../../src/services/db.service.ts";
import { setKeyPath } from "../../../src/lib/account-crypto.ts";
import { accountService } from "../../../src/services/account.service.ts";

const testKeyPath = resolve(tmpdir(), `ppm-test-accsvc-${Date.now()}.key`);
setKeyPath(testKeyPath);

beforeEach(() => {
  setDb(openTestDb());
});

afterEach(() => {
  setDb(openTestDb()); // keep db as in-memory, never null (closeDb → null → getDb opens prod DB)
  if (existsSync(testKeyPath)) unlinkSync(testKeyPath);
});

describe("AccountService", () => {
  it("add() stores account and list() returns it", () => {
    const acc = accountService.add({
      email: "test@example.com",
      accessToken: "access-123",
      refreshToken: "refresh-456",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(acc.email).toBe("test@example.com");
    expect(acc.status).toBe("active");

    const list = accountService.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(acc.id);
  });

  it("getWithTokens() returns decrypted tokens", () => {
    const acc = accountService.add({
      email: "t@t.com",
      accessToken: "my-access-token",
      refreshToken: "my-refresh-token",
      expiresAt: 9999999999,
    });
    const withTokens = accountService.getWithTokens(acc.id);
    expect(withTokens?.accessToken).toBe("my-access-token");
    expect(withTokens?.refreshToken).toBe("my-refresh-token");
  });

  it("setCooldown() sets status=cooldown + cooldownUntil", () => {
    const acc = accountService.add({ email: "a@b.com", accessToken: "t", refreshToken: "r", expiresAt: 0 });
    accountService.setCooldown(acc.id, Date.now() + 60_000);
    const updated = accountService.list().find((a) => a.id === acc.id)!;
    expect(updated.status).toBe("cooldown");
    expect(updated.cooldownUntil).toBeGreaterThan(0);
  });

  it("setDisabled() sets status=disabled", () => {
    const acc = accountService.add({ email: "a@b.com", accessToken: "t", refreshToken: "r", expiresAt: 0 });
    accountService.setDisabled(acc.id);
    expect(accountService.list()[0].status).toBe("disabled");
  });

  it("setEnabled() restores status=active", () => {
    const acc = accountService.add({ email: "a@b.com", accessToken: "t", refreshToken: "r", expiresAt: 0 });
    accountService.setDisabled(acc.id);
    accountService.setEnabled(acc.id);
    expect(accountService.list()[0].status).toBe("active");
  });

  it("remove() deletes account", () => {
    const acc = accountService.add({ email: "a@b.com", accessToken: "t", refreshToken: "r", expiresAt: 0 });
    accountService.remove(acc.id);
    expect(accountService.list()).toHaveLength(0);
  });

  it("trackUsage() increments totalRequests and sets lastUsedAt", () => {
    const acc = accountService.add({ email: "a@b.com", accessToken: "t", refreshToken: "r", expiresAt: 0 });
    accountService.trackUsage(acc.id);
    accountService.trackUsage(acc.id);
    const updated = accountService.list()[0];
    expect(updated.totalRequests).toBe(2);
    expect(updated.lastUsedAt).toBeGreaterThan(0);
  });

  it("updateTokens() re-encrypts tokens and updates expiresAt", () => {
    const acc = accountService.add({ email: "a@b.com", accessToken: "old", refreshToken: "old-r", expiresAt: 0 });
    const newExpiry = Math.floor(Date.now() / 1000) + 7200;
    accountService.updateTokens(acc.id, "new-access", "new-refresh", newExpiry);
    const withTokens = accountService.getWithTokens(acc.id)!;
    expect(withTokens.accessToken).toBe("new-access");
    expect(withTokens.refreshToken).toBe("new-refresh");
    expect(withTokens.expiresAt).toBe(newExpiry);
    expect(withTokens.status).toBe("active");
  });

  it("updateTokens() leaves a disabled account disabled", () => {
    // Usage polling deliberately refreshes parked accounts, and export refreshes every
    // account before writing a backup. Activating on refresh silently returned a parked
    // account to the chat rotation, which read as the toggle resetting itself.
    const acc = accountService.add({ email: "parked@b.com", accessToken: "old", refreshToken: "old-r", expiresAt: 0 });
    accountService.setDisabled(acc.id);

    accountService.updateTokens(acc.id, "fresh-access", "fresh-refresh", Math.floor(Date.now() / 1000) + 7200);

    const after = accountService.getWithTokens(acc.id)!;
    expect(after.status).toBe("disabled");
    expect(after.accessToken).toBe("fresh-access"); // still refreshed, just not re-enabled
  });

  it("updateTokens() clears a cooldown, since a fresh token is what ends one", () => {
    const acc = accountService.add({ email: "cool@b.com", accessToken: "old", refreshToken: "old-r", expiresAt: 0 });
    accountService.setCooldown(acc.id, Date.now() + 60_000);

    accountService.updateTokens(acc.id, "fresh-access", "fresh-refresh", Math.floor(Date.now() / 1000) + 7200);

    const after = accountService.list().find((a) => a.id === acc.id)!;
    expect(after.status).toBe("active");
    expect(after.cooldownUntil).toBeFalsy();
  });

  it("exportEncrypted() / importEncrypted() round-trips accounts with password", async () => {
    accountService.add({ email: "export@test.com", accessToken: "tok-a", refreshToken: "tok-r", expiresAt: 9999 });
    const blob = accountService.exportEncrypted("test-password-123");
    // Blob is an encrypted JSON envelope — not readable plaintext
    expect(blob).not.toContain("export@test.com");
    expect(blob).not.toContain("tok-a");
    const parsed = JSON.parse(blob);
    expect(parsed.version).toBe(1);
    expect(parsed.kdf).toBe("scrypt");

    // Remove and restore
    accountService.remove(accountService.list()[0].id);
    expect(accountService.list()).toHaveLength(0);

    const result = await accountService.importEncrypted(blob, "test-password-123");
    expect(result.imported).toBe(1);
    const restored = accountService.getWithTokens(accountService.list()[0].id)!;
    expect(restored.email).toBe("export@test.com");
    expect(restored.accessToken).toBe("tok-a");
  });

  it("importEncrypted() throws on wrong password", () => {
    accountService.add({ email: "pw@test.com", accessToken: "tok", refreshToken: "r", expiresAt: 0 });
    const blob = accountService.exportEncrypted("correct-password");
    expect(() => accountService.importEncrypted(blob, "wrong-password")).toThrow("Wrong password");
  });

  it("exportEncrypted() with accountIds only exports selected accounts", async () => {
    const a1 = accountService.add({ email: "a1@test.com", accessToken: "t1", refreshToken: "r1", expiresAt: 0 });
    accountService.add({ email: "a2@test.com", accessToken: "t2", refreshToken: "r2", expiresAt: 0 });
    const blob = accountService.exportEncrypted("pass", [a1.id]);
    // Decrypt and verify only a1 is included
    const { decryptWithPassword } = await import("../../../src/lib/account-crypto.ts");
    const plain = JSON.parse(decryptWithPassword(blob, "pass"));
    expect(plain).toHaveLength(1);
    expect(plain[0].email).toBe("a1@test.com");
  });

  it("add() carries new tokens into a parked account without un-parking it", async () => {
    // Signing in again is how a user gets a live token onto a parked account; it is not a
    // decision to put the account back in the rotation. The tokens have to actually land,
    // though — a status-preserving path that also dropped the tokens would look identical
    // from the toggle, so both halves are asserted here.
    const acc = accountService.add({
      email: "relogin@test.com", accessToken: "old", refreshToken: "old-r", expiresAt: 1,
    });
    accountService.setDisabled(acc.id);

    accountService.add({
      email: "relogin@test.com", accessToken: "new", refreshToken: "new-r", expiresAt: 9999999999,
    });

    const after = accountService.list().find((a) => a.id === acc.id)!;
    expect(accountService.list()).toHaveLength(1);   // matched the duplicate, did not add
    expect(after.status).toBe("disabled");
    expect(accountService.getWithTokens(acc.id)!.accessToken).toBe("new");
  });

  it("addManual() leaves a parked account parked, matching add()", async () => {
    // The two doors disagreed: pasting a token force-enabled while signing in preserved.
    // Whichever rule wins, they have to be the same rule — that split is the actual bug.
    const acc = accountService.add({
      email: "paste@test.com", accessToken: "sk-ant-oat-old", refreshToken: "r", expiresAt: 9999999999,
    });
    accountService.setDisabled(acc.id);

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ account: { email: "paste@test.com" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
    try {
      await accountService.addManual({ apiKey: "sk-ant-oat-new", label: null });
    } finally {
      globalThis.fetch = realFetch;
    }

    const after = accountService.list().find((a) => a.id === acc.id)!;
    expect(accountService.list()).toHaveLength(1);
    expect(after.status).toBe("disabled");
    expect(accountService.getWithTokens(acc.id)!.accessToken).toBe("sk-ant-oat-new");
  });

  it("updateTokens() clears a stale cooldown even on a parked account", () => {
    // The parked branch used to skip cooldown_until, so a 429 that arrived before the
    // user parked the account would resurrect it the moment the park was lifted.
    const acc = accountService.add({ email: "c@t.com", accessToken: "a", refreshToken: "r", expiresAt: 0 });
    accountService.setCooldown(acc.id, Date.now() + 600_000);
    accountService.setDisabled(acc.id);

    accountService.updateTokens(acc.id, "fresh", "fresh-r", 9999999999);

    const after = accountService.list().find((a) => a.id === acc.id)!;
    expect(after.status).toBe("disabled");
    expect(after.cooldownUntil).toBeFalsy();
  });

  it("importEncrypted() does not claim ownership of a parked account's token", async () => {
    // The post-import refresh exists to make this machine the owner of the token. Running
    // it for an account this machine has parked spends the refresh token — invalidating
    // whichever machine is still using the account — to claim something nobody asked for.
    // Enabling the account is what claims it.
    const acc = accountService.add({
      email: "claim@test.com", accessToken: "sk-ant-oat-a", refreshToken: "r", expiresAt: 1,
    });
    const blob = accountService.exportEncrypted("pass", undefined, true);
    accountService.setDisabled(acc.id);

    const realFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (u: unknown) => {
      urls.push(String(u));
      return new Response("{}", { status: 500 });
    }) as typeof fetch;
    try {
      await accountService.importEncrypted(blob, "pass");
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(urls.some((u) => u.includes("/oauth/token"))).toBe(false);
    expect(accountService.list().find((a) => a.id === acc.id)!.status).toBe("disabled");
  });

  it("importEncrypted() does not import a status the app cannot use", async () => {
    // The column has no CHECK constraint and the blob is user-supplied. A stray value
    // reads as *on* in the UI (status !== "disabled") but is never selectable for a turn.
    const acc = accountService.add({
      email: "bogus@test.com", accessToken: "a", refreshToken: "r",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const blob = accountService.exportEncrypted("pass", undefined, true);
    accountService.remove(acc.id);

    const { decryptWithPassword, encryptWithPassword } = await import("../../../src/lib/account-crypto.ts");
    const rows = JSON.parse(decryptWithPassword(blob, "pass"));
    rows[0].status = "paused";
    const tampered = encryptWithPassword(JSON.stringify(rows), "pass");

    await accountService.importEncrypted(tampered, "pass");
    expect(accountService.list()[0].status).toBe("active");
  });

  it("importEncrypted() leaves an account parked on this machine parked", async () => {
    // Regression: the update-existing branch set status "active" unconditionally, so
    // restoring a backup silently put a parked account back in the chat rotation.
    const acc = accountService.add({
      email: "parked@test.com",
      accessToken: "backed-up-access",
      refreshToken: "backed-up-refresh",
      // Fresh, so the post-import ownership refresh short-circuits before any OAuth call.
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const blob = accountService.exportEncrypted("pass", undefined, true);

    // The state the user is in when they restore: tokens have moved on locally, and the
    // account has since been parked.
    accountService.updateTokens(acc.id, "stale-access", "stale-refresh", 1);
    accountService.setDisabled(acc.id);

    const result = await accountService.importEncrypted(blob, "pass");
    expect(result.imported).toBe(1);

    const after = accountService.list().find((a) => a.id === acc.id)!;
    expect(after.status).toBe("disabled");
    // The tokens still had to land — parking is about the rotation, not about the import.
    expect(accountService.getWithTokens(acc.id)!.accessToken).toBe("backed-up-access");
  });

  it("importEncrypted() gives a brand-new account the status the backup carried", async () => {
    // The other half of the rule: with no local account there is no local decision to
    // respect, so the backup's own status wins.
    const acc = accountService.add({
      email: "fresh@test.com",
      accessToken: "acc",
      refreshToken: "ref",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    accountService.setDisabled(acc.id);
    const blob = accountService.exportEncrypted("pass", undefined, true);
    accountService.remove(acc.id);

    const result = await accountService.importEncrypted(blob, "pass");
    expect(result.imported).toBe(1);
    expect(accountService.list()[0].status).toBe("disabled");
  });

  it("importEncrypted() skips duplicate accounts", async () => {
    const acc = accountService.add({ email: "dup@test.com", accessToken: "tok", refreshToken: "r", expiresAt: 0 });
    const blob = accountService.exportEncrypted("pass");
    const result = await accountService.importEncrypted(blob, "pass");
    expect(result.imported).toBe(0); // already exists
    expect(accountService.list()).toHaveLength(1);
    expect(accountService.list()[0].id).toBe(acc.id);
  });

  it("refreshAccessToken() preserves refresh token when OAuth returns invalid_grant", async () => {
    // Regression: a rejected refresh token must NOT be wiped. On multi-device/multi-process
    // setups the token is usually rotated elsewhere, not dead — clearing it permanently
    // bricks parked/disabled accounts with no recovery path.
    const acc = accountService.add({
      email: "rotate@test.com",
      accessToken: "sk-ant-oat-old-access",
      refreshToken: "refresh-still-good-elsewhere",
      expiresAt: Math.floor(Date.now() / 1000) - 100, // expired → forces the OAuth call
    });

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "Refresh token expired" }),
        { status: 400 },
      )) as typeof fetch;
    try {
      await expect(accountService.refreshAccessToken(acc.id, false)).rejects.toThrow();
    } finally {
      globalThis.fetch = realFetch;
    }

    const after = accountService.getWithTokens(acc.id)!;
    expect(after.refreshToken).toBe("refresh-still-good-elsewhere");
    expect(accountService.hasRefreshToken(acc.id)).toBe(true);
  });

  it("startOAuthFlow() returns valid Claude OAuth URL", () => {
    const url = accountService.startOAuthFlow("http://localhost:8081/api/accounts/oauth/callback");
    expect(url).toStartWith("https://claude.ai/oauth/authorize");
    expect(url).toContain("code_challenge=");
    expect(url).toContain("state=");
  });
});

describe("AccountService.refreshAccessToken", () => {
  const originalFetch = globalThis.fetch;
  let calls: number;

  /** Queue of responses/errors returned by successive fetch calls. */
  function mockOAuth(...results: (Response | Error)[]) {
    calls = 0;
    globalThis.fetch = mock(() => {
      const result = results[Math.min(calls, results.length - 1)];
      calls++;
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result.clone());
    }) as any;
  }

  function tokenResponse(accessToken = "fresh-access") {
    return new Response(
      JSON.stringify({ access_token: accessToken, refresh_token: "rotated-refresh", expires_in: 28800 }),
      { status: 200 },
    );
  }

  /** Account whose token is valid for another 30 minutes. */
  function halfHourAccount() {
    return accountService.add({
      email: "refresh@test.com",
      accessToken: "sk-ant-oat-old",
      refreshToken: "refresh-token",
      expiresAt: Math.floor(Date.now() / 1000) + 1800,
    });
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("honours a caller-supplied freshness threshold instead of the hardcoded 60s guard", async () => {
    // Regression: the proactive 1h buffer used to be cancelled by an inner 60s guard,
    // so tokens were only ever refreshed after they had already expired.
    const acc = halfHourAccount();
    mockOAuth(tokenResponse());

    await accountService.refreshAccessToken(acc.id, false, false, 3600);

    expect(calls).toBe(1);
    expect(accountService.getWithTokens(acc.id)!.accessToken).toBe("fresh-access");
  });

  it("skips the OAuth call when the token is fresher than the threshold", async () => {
    const acc = halfHourAccount();
    mockOAuth(tokenResponse());

    await accountService.refreshAccessToken(acc.id, false);

    expect(calls).toBe(0);
    expect(accountService.getWithTokens(acc.id)!.accessToken).toBe("sk-ant-oat-old");
  });

  it("retries a transient network failure instead of burning the refresh cycle", async () => {
    const acc = halfHourAccount();
    mockOAuth(new Error("The operation timed out."), tokenResponse("recovered-access"));

    await accountService.refreshAccessToken(acc.id, false, false, 3600);

    expect(calls).toBe(2);
    expect(accountService.getWithTokens(acc.id)!.accessToken).toBe("recovered-access");
  });

  it("does not retry a permanent invalid_grant rejection", async () => {
    const acc = halfHourAccount();
    mockOAuth(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));

    await expect(accountService.refreshAccessToken(acc.id, false, false, 3600)).rejects.toThrow("invalid_grant");
    expect(calls).toBe(1);
  });
});
