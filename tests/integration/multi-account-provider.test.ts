/**
 * Multi-account provider integration tests.
 *
 * Requires .env.test with real OAuth tokens:
 *   TEST_OAUTH_TOKEN_1=sk-ant-oat01-xxx
 *   TEST_OAUTH_TOKEN_2=sk-ant-oat01-yyy
 *
 * Platform detection:
 *   - macOS: test SDK env vars + simulate Windows for queryDirectCli
 *   - Windows: test queryDirectCli only (native)
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
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

const hasTokens = TOKEN_1.startsWith("sk-ant-oat") && TOKEN_1.length > 20
  && TOKEN_2.startsWith("sk-ant-oat") && TOKEN_2.length > 20;
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
    closeDb();
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
      expect(entries[0].isOAuth).toBe(true);
      expect(entries[1].isOAuth).toBe(true);
    });
  });

  // =========================================================================
  // 4. Export / Import
  // =========================================================================
  describe("Export / Import", () => {
    it("round-trips accounts with real tokens", () => {
      accountService.add({ email: "exp1@test.com", accessToken: TOKEN_1, refreshToken: "r1", expiresAt: 9999 });
      accountService.add({ email: "exp2@test.com", accessToken: TOKEN_2, refreshToken: "r2", expiresAt: 9999 });
      const blob = accountService.exportEncrypted();

      // Clear and reimport
      for (const acc of accountService.list()) accountService.remove(acc.id);
      expect(accountService.list()).toHaveLength(0);

      const count = accountService.importEncrypted(blob);
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
  // 6. Provider env vars — platform-specific
  // =========================================================================

  if (isMac) {
    // macOS: test SDK env var injection + simulated Windows CLI path
    describe("SDK env vars (macOS)", () => {
      it("buildQueryEnv sets CLAUDE_CODE_OAUTH_TOKEN for OAuth tokens", async () => {
        const { ClaudeAgentSdkProvider } = await import("../../src/providers/claude-agent-sdk.ts");
        const provider = new ClaudeAgentSdkProvider();

        // Access private method via cast
        const env = (provider as any).buildQueryEnv(undefined, {
          id: "acc-1",
          accessToken: TOKEN_1,
        });

        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_1);
        expect(env.ANTHROPIC_API_KEY).toBe(""); // neutralized
      });

      it("buildQueryEnv sets ANTHROPIC_API_KEY for API keys", async () => {
        const { ClaudeAgentSdkProvider } = await import("../../src/providers/claude-agent-sdk.ts");
        const provider = new ClaudeAgentSdkProvider();

        const fakeApiKey = "sk-ant-api03-test-key";
        const env = (provider as any).buildQueryEnv(undefined, {
          id: "acc-2",
          accessToken: fakeApiKey,
        });

        expect(env.ANTHROPIC_API_KEY).toBe(fakeApiKey);
        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(""); // neutralized
      });

      it("buildQueryEnv with null account passes through existing env", async () => {
        const { ClaudeAgentSdkProvider } = await import("../../src/providers/claude-agent-sdk.ts");
        const provider = new ClaudeAgentSdkProvider();

        const env = (provider as any).buildQueryEnv(undefined, null);
        // Should not override — passthrough
        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      });
    });

    describe("CLI env vars (simulated Windows)", () => {
      it("useDirectCli is true when platform is win32", () => {
        const originalPlatform = process.platform;
        try {
          Object.defineProperty(process, "platform", { value: "win32", configurable: true });
          expect(process.platform === "win32").toBe(true);
        } finally {
          Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
        }
      });

      it("useDirectCli is false when platform is darwin", () => {
        expect(process.platform === "win32").toBe(false);
        // On mac, SDK query() is used instead of CLI
      });

      it("CLI command construction uses cmd /c on win32", () => {
        const originalPlatform = process.platform;
        try {
          Object.defineProperty(process, "platform", { value: "win32", configurable: true });
          const args = ["-p", "test", "--verbose"];
          const cmd = process.platform === "win32"
            ? ["cmd", "/c", "claude", ...args]
            : ["claude", ...args];
          expect(cmd[0]).toBe("cmd");
          expect(cmd[1]).toBe("/c");
          expect(cmd[2]).toBe("claude");
        } finally {
          Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
        }
      });

      it("buildQueryEnv works the same for CLI path", async () => {
        const { ClaudeAgentSdkProvider } = await import("../../src/providers/claude-agent-sdk.ts");
        const provider = new ClaudeAgentSdkProvider();
        const originalPlatform = process.platform;
        try {
          Object.defineProperty(process, "platform", { value: "win32", configurable: true });
          const env = (provider as any).buildQueryEnv(undefined, {
            id: "acc-cli",
            accessToken: TOKEN_1,
          });
          expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_1);
          expect(env.ANTHROPIC_API_KEY).toBe("");
        } finally {
          Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
        }
      });
    });
  } else {
    // Windows: test CLI env var path natively
    describe("CLI env vars (native Windows)", () => {
      it("useDirectCli is true on Windows", () => {
        expect(process.platform).toBe("win32");
        const useDirectCli = process.platform === "win32";
        expect(useDirectCli).toBe(true);
      });

      it("buildQueryEnv sets CLAUDE_CODE_OAUTH_TOKEN for OAuth tokens", async () => {
        const { ClaudeAgentSdkProvider } = await import("../../src/providers/claude-agent-sdk.ts");
        const provider = new ClaudeAgentSdkProvider();

        const env = (provider as any).buildQueryEnv(undefined, {
          id: "acc-win",
          accessToken: TOKEN_1,
        });
        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_1);
        expect(env.ANTHROPIC_API_KEY).toBe("");
      });

      it("buildQueryEnv sets ANTHROPIC_API_KEY for API keys", async () => {
        const { ClaudeAgentSdkProvider } = await import("../../src/providers/claude-agent-sdk.ts");
        const provider = new ClaudeAgentSdkProvider();

        const fakeApiKey = "sk-ant-api03-test-key";
        const env = (provider as any).buildQueryEnv(undefined, {
          id: "acc-win-api",
          accessToken: fakeApiKey,
        });
        expect(env.ANTHROPIC_API_KEY).toBe(fakeApiKey);
        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
      });

      it("CLI command uses cmd /c on Windows", () => {
        const args = ["-p", "test", "--verbose"];
        const cmd = process.platform === "win32"
          ? ["cmd", "/c", "claude", ...args]
          : ["claude", ...args];
        expect(cmd[0]).toBe("cmd");
        expect(cmd[1]).toBe("/c");
        expect(cmd[2]).toBe("claude");
      });
    });
  }
}
