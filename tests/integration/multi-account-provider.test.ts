/**
 * Multi-account provider integration tests.
 *
 * Requires .env.test with real tokens (OAuth or API key):
 *   TEST_OAUTH_TOKEN_1=sk-ant-oat01-xxx  (or sk-ant-api03-xxx)
 *   TEST_OAUTH_TOKEN_2=sk-ant-oat01-yyy  (or sk-ant-api03-yyy)
 *
 * Platform detection:
 *   - macOS: test SDK real AI call
 *   - Windows: SDK with executable: "node" (bypasses Bun spawn ENOENT)
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setKeyPath } from "../../src/lib/account-crypto.ts";
import { openTestDb, setDb, closeDb } from "../../src/services/db.service.ts";
import { accountService } from "../../src/services/account.service.ts";
import { accountSelector } from "../../src/services/account-selector.service.ts";

// ---------------------------------------------------------------------------
// Load .env.test tokens
// ---------------------------------------------------------------------------
const envTestPath = resolve(import.meta.dir, "../../.env.test");
let TOKEN_1 = "";
let TOKEN_2 = "";

if (existsSync(envTestPath)) {
  const lines = readFileSync(envTestPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    const value = rest.join("=").trim();
    if (key === "TEST_OAUTH_TOKEN_1") TOKEN_1 = value;
    if (key === "TEST_OAUTH_TOKEN_2") TOKEN_2 = value;
  }
}

function isValidToken(t: string) {
  return (t.startsWith("sk-ant-oat") || t.startsWith("sk-ant-api")) && t.length > 20;
}

const hasTokens = isValidToken(TOKEN_1) && isValidToken(TOKEN_2);
const isMac = process.platform === "darwin";

// Skip entire file if no tokens
if (!hasTokens) {
  describe.skip("Multi-account provider (no .env.test tokens)", () => {
    it("skipped — create .env.test with real tokens", () => {});
  });
} else {
  // ---------------------------------------------------------------------------
  // Setup: in-memory DB + temp encryption key
  // ---------------------------------------------------------------------------
  const testKeyPath = resolve(tmpdir(), `ppm-test-multi-${Date.now()}.key`);
  setKeyPath(testKeyPath);

  beforeAll(() => {
    setDb(openTestDb());
  });

  beforeEach(() => {
    setDb(openTestDb());
    setKeyPath(testKeyPath);
    accountSelector.setStrategy("round-robin");
    accountSelector.setMaxRetry(0);
  });

  afterAll(() => {
    setDb(openTestDb()); // keep db as in-memory, never null (closeDb → null → getDb opens prod DB)
    if (existsSync(testKeyPath)) unlinkSync(testKeyPath);
  });

  // =========================================================================
  // 1. Account CRUD with real tokens
  // =========================================================================
  describe("Account CRUD with real tokens", () => {
    it("add two accounts and list them", () => {
      const a1 = accountService.add({
        email: "test1@example.com",
        accessToken: TOKEN_1,
        refreshToken: "ref-1",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });
      const a2 = accountService.add({
        email: "test2@example.com",
        accessToken: TOKEN_2,
        refreshToken: "ref-2",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });

      const list = accountService.list();
      expect(list).toHaveLength(2);
      expect(list.map((a) => a.email)).toContain("test1@example.com");
      expect(list.map((a) => a.email)).toContain("test2@example.com");

      // Verify token decryption
      const wt1 = accountService.getWithTokens(a1.id);
      expect(wt1?.accessToken).toBe(TOKEN_1);
      const wt2 = accountService.getWithTokens(a2.id);
      expect(wt2?.accessToken).toBe(TOKEN_2);
    });

    it("remove account reduces list", () => {
      const a1 = accountService.add({ email: "rem@test.com", accessToken: TOKEN_1, refreshToken: "r", expiresAt: 0 });
      accountService.add({ email: "keep@test.com", accessToken: TOKEN_2, refreshToken: "r", expiresAt: 0 });
      accountService.remove(a1.id);
      expect(accountService.list()).toHaveLength(1);
      expect(accountService.list()[0].email).toBe("keep@test.com");
    });
  });

  // =========================================================================
  // 2. Token rotation
  // =========================================================================
  describe("Token rotation", () => {
    it("updateTokens swaps tokens and preserves account", () => {
      const acc = accountService.add({ email: "rot@test.com", accessToken: TOKEN_1, refreshToken: "r1", expiresAt: 0 });
      const newExpiry = Math.floor(Date.now() / 1000) + 7200;
      accountService.updateTokens(acc.id, TOKEN_2, "r2", newExpiry);

      const updated = accountService.getWithTokens(acc.id)!;
      expect(updated.accessToken).toBe(TOKEN_2);
      expect(updated.refreshToken).toBe("r2");
      expect(updated.expiresAt).toBe(newExpiry);
    });
  });

  // =========================================================================
  // 3. Usage polling (real API call)
  // =========================================================================
  describe("Usage polling", () => {
    it("getAllAccountUsages returns per-account usage", async () => {
      accountService.add({ email: "usage1@test.com", accessToken: TOKEN_1, refreshToken: "r", expiresAt: 9999999999 });
      accountService.add({ email: "usage2@test.com", accessToken: TOKEN_2, refreshToken: "r", expiresAt: 9999999999 });

      const { getAllAccountUsages } = await import("../../src/services/claude-usage.service.ts");
      const entries = getAllAccountUsages();
      expect(entries).toHaveLength(2);
      expect(entries[0].accountId).toBeTruthy();
      expect(entries[1].accountId).toBeTruthy();
      // isOAuth reflects actual token type
      const expectedIsOAuth1 = TOKEN_1.startsWith("sk-ant-oat");
      const expectedIsOAuth2 = TOKEN_2.startsWith("sk-ant-oat");
      expect(entries[0].isOAuth).toBe(expectedIsOAuth1);
      expect(entries[1].isOAuth).toBe(expectedIsOAuth2);
    });
  });

  // =========================================================================
  // 4. Export / Import
  // =========================================================================
  describe("Export / Import", () => {
    it("round-trips accounts with real tokens", () => {
      accountService.add({ email: "exp1@test.com", accessToken: TOKEN_1, refreshToken: "r1", expiresAt: 9999 });
      accountService.add({ email: "exp2@test.com", accessToken: TOKEN_2, refreshToken: "r2", expiresAt: 9999 });
      const blob = accountService.exportEncrypted("test-pass");

      // Clear and reimport
      for (const acc of accountService.list()) accountService.remove(acc.id);
      expect(accountService.list()).toHaveLength(0);

      const count = accountService.importEncrypted(blob, "test-pass");
      expect(count).toBe(2);

      const list = accountService.list();
      expect(list).toHaveLength(2);
      const wt1 = accountService.getWithTokens(list[0].id)!;
      const wt2 = accountService.getWithTokens(list[1].id)!;
      const tokens = [wt1.accessToken, wt2.accessToken];
      expect(tokens).toContain(TOKEN_1);
      expect(tokens).toContain(TOKEN_2);
    });
  });

  // =========================================================================
  // 5. Decrypt error handling (mismatched key)
  // =========================================================================
  describe("Decrypt error handling", () => {
    it("getWithTokens returns null on mismatched key", () => {
      // Add account with current key
      const acc = accountService.add({ email: "crypt@test.com", accessToken: TOKEN_1, refreshToken: "r", expiresAt: 0 });

      // Switch to a different key file
      const altKeyPath = resolve(tmpdir(), `ppm-test-alt-key-${Date.now()}.key`);
      setKeyPath(altKeyPath);

      // getWithTokens should return null (not throw)
      const result = accountService.getWithTokens(acc.id);
      expect(result).toBeNull();

      // Cleanup: restore original key
      setKeyPath(testKeyPath);
      if (existsSync(altKeyPath)) unlinkSync(altKeyPath);
    });
  });

  // =========================================================================
  // 6. Default auth — no explicit token, relies on ambient env
  // =========================================================================
  describe("Default auth (no account token)", () => {
    it("SDK query() works with ambient env (no account injection)", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const { ClaudeAgentSdkProvider } = await import("../../src/providers/claude-agent-sdk.ts");
      const provider = new ClaudeAgentSdkProvider();

      // null account → passthrough process.env as-is (no token injection)
      const env = (provider as any).buildQueryEnv(undefined, null) as Record<string, string | undefined>;

      let text = "";
      const gen = query({
        prompt: "Reply with only the word: pong",
        options: {
          cwd: process.cwd(),
          env,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 1,
        } as any,
      });

      for await (const event of gen) {
        if ((event as any).type === "assistant") {
          for (const block of (event as any).message?.content ?? []) {
            if (block.type === "text") text += block.text;
          }
        }
      }

      console.log(`[default-sdk] response: "${text.slice(0, 100)}"`);
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text.toLowerCase()).toContain("pong");
    }, { timeout: 90_000 });

  });

  // =========================================================================
  // 7. Real AI call tests — platform-specific
  // =========================================================================

  if (isMac) {
    // -----------------------------------------------------------------------
    // macOS: SDK real AI call
    // -----------------------------------------------------------------------
    describe("SDK real AI call (macOS)", () => {
      it("query() returns text response using token from env", async () => {
        const { query } = await import("@anthropic-ai/claude-agent-sdk");
        const { ClaudeAgentSdkProvider } = await import("../../src/providers/claude-agent-sdk.ts");
        const provider = new ClaudeAgentSdkProvider();

        // Build env the same way the provider does in production
        const env = (provider as any).buildQueryEnv(undefined, {
          id: "sdk-e2e-test",
          accessToken: TOKEN_1,
        }) as Record<string, string | undefined>;

        let text = "";
        const gen = query({
          prompt: 'Reply with only the word: pong',
          options: {
            cwd: process.cwd(),
            env,
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            maxTurns: 1,
          } as any,
        });

        for await (const event of gen) {
          // SDK yields AssistantMessage events with content blocks
          if ((event as any).type === "assistant") {
            for (const block of (event as any).message?.content ?? []) {
              if (block.type === "text") text += block.text;
            }
          }
        }

        console.log(`[sdk-e2e] response: "${text.slice(0, 100)}"`);
        expect(text.trim().length).toBeGreaterThan(0);
        expect(text.toLowerCase()).toContain("pong");
      }, { timeout: 90_000 });
    });

  } else {
    // Windows uses executable: "node" in SDK query — same SDK path as macOS
  }
}
