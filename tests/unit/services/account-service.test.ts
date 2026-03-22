import { describe, it, expect, beforeEach, afterEach } from "bun:test";
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

  it("exportEncrypted() / importEncrypted() round-trips accounts with password", () => {
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

    const count = accountService.importEncrypted(blob, "test-password-123");
    expect(count).toBe(1);
    const restored = accountService.getWithTokens(accountService.list()[0].id)!;
    expect(restored.email).toBe("export@test.com");
    expect(restored.accessToken).toBe("tok-a");
  });

  it("importEncrypted() throws on wrong password", () => {
    accountService.add({ email: "pw@test.com", accessToken: "tok", refreshToken: "r", expiresAt: 0 });
    const blob = accountService.exportEncrypted("correct-password");
    expect(() => accountService.importEncrypted(blob, "wrong-password")).toThrow("Wrong password");
  });

  it("exportEncrypted() with accountIds only exports selected accounts", () => {
    const a1 = accountService.add({ email: "a1@test.com", accessToken: "t1", refreshToken: "r1", expiresAt: 0 });
    accountService.add({ email: "a2@test.com", accessToken: "t2", refreshToken: "r2", expiresAt: 0 });
    const blob = accountService.exportEncrypted("pass", [a1.id]);
    // Decrypt and verify only a1 is included
    const { decryptWithPassword } = require("../../../src/lib/account-crypto.ts");
    const plain = JSON.parse(decryptWithPassword(blob, "pass"));
    expect(plain).toHaveLength(1);
    expect(plain[0].email).toBe("a1@test.com");
  });

  it("importEncrypted() skips duplicate accounts", () => {
    const acc = accountService.add({ email: "dup@test.com", accessToken: "tok", refreshToken: "r", expiresAt: 0 });
    const blob = accountService.exportEncrypted("pass");
    const count = accountService.importEncrypted(blob, "pass");
    expect(count).toBe(0); // already exists
    expect(accountService.list()).toHaveLength(1);
    expect(accountService.list()[0].id).toBe(acc.id);
  });

  it("startOAuthFlow() returns valid Claude OAuth URL", () => {
    const url = accountService.startOAuthFlow("http://localhost:8081/api/accounts/oauth/callback");
    expect(url).toStartWith("https://claude.ai/oauth/authorize");
    expect(url).toContain("code_challenge=");
    expect(url).toContain("state=");
  });
});
