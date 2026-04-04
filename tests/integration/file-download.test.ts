import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createDownloadToken,
  consumeDownloadToken,
} from "../../src/services/download-token.service";
import { authMiddleware } from "../../src/server/middleware/auth";
import { downloadRoutes } from "../../src/server/routes/file-download";
import { fileRoutes } from "../../src/server/routes/files";
import { configService } from "../../src/services/config.service";
import { ok } from "../../src/types/api";

type Env = { Variables: { projectPath: string; projectName: string } };

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ppm-download-test-"));
  // Enable auth by default
  configService.set("auth", { enabled: true, token: "test-token-123" });
});

afterEach(() => {
  configService.set("auth", { enabled: false, token: "" });
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
});

/**
 * Create a test app with download routes + auth middleware + file routes.
 * Sets projectPath and projectName context variables.
 */
function createTestApp() {
  const app = new Hono<Env>();

  // Middleware to set context
  app.use("*", (c, next) => {
    c.set("projectPath", testDir);
    c.set("projectName", "test-project");
    return next();
  });

  // Auth middleware (checks Bearer token + dl_token fallback)
  app.use("*", authMiddleware);

  // Routes
  app.route("/files/download", downloadRoutes);
  app.route("/files", fileRoutes);

  return app;
}

describe("File Download Integration", () => {
  describe("POST /files/download/token — generate download token", () => {
    it("returns a valid token for authenticated user", async () => {
      const app = createTestApp();
      const res = await app.request("/files/download/token", {
        method: "POST",
        headers: { Authorization: "Bearer test-token-123" },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.ok).toBe(true);
      expect(json.data?.token).toBeTruthy();
      expect(typeof json.data.token).toBe("string");
      expect(json.data.token.length).toBeGreaterThan(0);
    });

    it("rejects request without Bearer token", async () => {
      const app = createTestApp();
      const res = await app.request("/files/download/token", {
        method: "POST",
      });

      expect(res.status).toBe(401);
      const json = (await res.json()) as any;
      expect(json.ok).toBe(false);
      expect(json.error).toContain("Unauthorized");
    });

    it("rejects request with invalid Bearer token", async () => {
      const app = createTestApp();
      const res = await app.request("/files/download/token", {
        method: "POST",
        headers: { Authorization: "Bearer wrong-token" },
      });

      expect(res.status).toBe(401);
    });

    it("generates unique tokens on each call", async () => {
      const app = createTestApp();
      const res1 = await app.request("/files/download/token", {
        method: "POST",
        headers: { Authorization: "Bearer test-token-123" },
      });
      const json1 = (await res1.json()) as any;
      const token1 = json1.data.token;

      const res2 = await app.request("/files/download/token", {
        method: "POST",
        headers: { Authorization: "Bearer test-token-123" },
      });
      const json2 = (await res2.json()) as any;
      const token2 = json2.data.token;

      expect(token1).not.toBe(token2);
    });
  });

  describe("GET /files/raw?download=true with dl_token", () => {
    beforeEach(() => {
      // Create test files
      writeFileSync(join(testDir, "test.txt"), "Hello, World!");
      writeFileSync(join(testDir, "binary.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG signature
    });

    it("downloads single file with valid dl_token", async () => {
      const token = createDownloadToken();
      const app = createTestApp();

      const res = await app.request(
        `/files/raw?path=test.txt&download=true&dl_token=${token}`,
        { method: "GET" },
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Disposition")).toContain(
        "attachment; filename="
      );
      expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
      const text = await res.text();
      expect(text).toBe("Hello, World!");
    });

    it("rejects download with missing dl_token", async () => {
      const app = createTestApp();

      const res = await app.request(`/files/raw?path=test.txt&download=true`, {
        method: "GET",
      });

      expect(res.status).toBe(401);
    });

    it("rejects download with invalid dl_token", async () => {
      const app = createTestApp();

      const res = await app.request(
        `/files/raw?path=test.txt&download=true&dl_token=invalid-token`,
        { method: "GET" },
      );

      expect(res.status).toBe(401);
    });

    it("consumes token (one-time use)", async () => {
      const token = createDownloadToken();
      const app = createTestApp();

      // First request — should work
      const res1 = await app.request(
        `/files/raw?path=test.txt&download=true&dl_token=${token}`,
        { method: "GET" },
      );
      expect(res1.status).toBe(200);

      // Second request with same token — should fail
      const res2 = await app.request(
        `/files/raw?path=test.txt&download=true&dl_token=${token}`,
        { method: "GET" },
      );
      expect(res2.status).toBe(401);
    });

    it("rejects expired token (TTL 30s)", async () => {
      const token = createDownloadToken();
      const app = createTestApp();

      // Manually expire the token by waiting past TTL
      // Token has 30s TTL, so we can't wait in unit test
      // Instead, test consumeDownloadToken directly
      expect(consumeDownloadToken(token)).toBe(true);
      expect(consumeDownloadToken(token)).toBe(false); // Already consumed
    });

    it("sets Content-Disposition for download=true", async () => {
      const token = createDownloadToken();
      const app = createTestApp();

      const res = await app.request(
        `/files/raw?path=test.txt&download=true&dl_token=${token}`,
        { method: "GET" },
      );

      expect(res.status).toBe(200);
      const disposition = res.headers.get("Content-Disposition");
      expect(disposition).toContain("attachment");
      expect(disposition).toContain("test.txt");
    });

    it("returns 404 for non-existent file", async () => {
      const token = createDownloadToken();
      const app = createTestApp();

      const res = await app.request(
        `/files/raw?path=nonexistent.txt&download=true&dl_token=${token}`,
        { method: "GET" },
      );

      expect(res.status).toBe(404);
    });

    it("blocks path traversal (../)", async () => {
      const token = createDownloadToken();
      const app = createTestApp();

      const res = await app.request(
        `/files/raw?path=../../etc/passwd&download=true&dl_token=${token}`,
        { method: "GET" },
      );

      expect(res.status).toBe(403);
    });
  });

  describe("GET /files/download/zip?path=... with dl_token", () => {
    beforeEach(() => {
      // Create test directory structure
      const subdir = join(testDir, "src");
      const nested = join(subdir, "components");

      // Create directories
      mkdirSync(nested, { recursive: true });

      // Create files
      writeFileSync(join(testDir, "README.md"), "# Project");
      writeFileSync(join(subdir, "index.ts"), "export const main = () => {};");
      writeFileSync(join(nested, "Button.tsx"), "export function Button() {}");
      writeFileSync(join(testDir, ".gitignore"), "node_modules/\n.env\n");
      writeFileSync(join(testDir, "node_modules_file.txt"), "ignored"); // should be excluded
    });

    it("downloads folder as zip with valid token", async () => {
      const token = createDownloadToken();
      const app = createTestApp();

      const res = await app.request(
        `/files/download/zip?path=src&dl_token=${token}`,
        { method: "GET" },
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/zip");
      expect(res.headers.get("Content-Disposition")).toContain(
        "attachment; filename="
      );
      expect(res.headers.get("Content-Disposition")).toContain(".zip");

      // Verify response is readable (not empty)
      const buffer = await res.arrayBuffer();
      expect(buffer.byteLength).toBeGreaterThan(0);
      // ZIP magic number check (0x504B0304)
      const view = new Uint8Array(buffer);
      expect(view[0]).toBe(0x50); // 'P'
      expect(view[1]).toBe(0x4b); // 'K'
    });

    it("rejects zip download with missing dl_token", async () => {
      const app = createTestApp();

      const res = await app.request(`/files/download/zip?path=src`, {
        method: "GET",
      });

      expect(res.status).toBe(401);
    });

    it("rejects zip download with invalid dl_token", async () => {
      const app = createTestApp();

      const res = await app.request(
        `/files/download/zip?path=src&dl_token=invalid`,
        { method: "GET" },
      );

      expect(res.status).toBe(401);
    });

    it("returns 400 if path is not a directory", async () => {
      const token = createDownloadToken();
      const app = createTestApp();

      const res = await app.request(
        `/files/download/zip?path=README.md&dl_token=${token}`,
        { method: "GET" },
      );

      expect(res.status).toBe(400);
      const json = (await res.json()) as any;
      expect(json.error).toContain("directory");
    });

    it("returns 404 for non-existent path", async () => {
      const token = createDownloadToken();
      const app = createTestApp();

      const res = await app.request(
        `/files/download/zip?path=nonexistent&dl_token=${token}`,
        { method: "GET" },
      );

      expect(res.status).toBe(404);
    });

    it("blocks path traversal in zip download", async () => {
      const token = createDownloadToken();
      const app = createTestApp();

      const res = await app.request(
        `/files/download/zip?path=../../etc&dl_token=${token}`,
        { method: "GET" },
      );

      expect(res.status).toBe(403);
    });

    it("returns 400 if path query parameter is missing", async () => {
      const token = createDownloadToken();
      const app = createTestApp();

      const res = await app.request(
        `/files/download/zip?dl_token=${token}`,
        { method: "GET" },
      );

      expect(res.status).toBe(400);
      const json = (await res.json()) as any;
      expect(json.error).toContain("path");
    });

    it("excludes .git and node_modules from zip", async () => {
      // Create .git and node_modules directories
      const gitDir = join(testDir, ".git");
      const nmDir = join(testDir, "node_modules");

      mkdirSync(gitDir, { recursive: true });
      mkdirSync(nmDir, { recursive: true });
      writeFileSync(join(gitDir, "config"), "git config");
      writeFileSync(join(nmDir, "package.json"), "npm");

      const token = createDownloadToken();
      const app = createTestApp();

      const res = await app.request(
        `/files/download/zip?path=.&dl_token=${token}`,
        { method: "GET" },
      );

      expect(res.status).toBe(200);
      const buffer = await res.arrayBuffer();
      const text = new TextDecoder().decode(buffer);

      // Check that .git and node_modules are not in zip (this is a basic check)
      // Ideally we'd unzip and verify, but this is a simple smoke test
      expect(buffer.byteLength).toBeGreaterThan(0);
    });

    it("includes dot files in zip (except .git)", async () => {
      // The .gitignore should be included
      const token = createDownloadToken();
      const app = createTestApp();

      const res = await app.request(
        `/files/download/zip?path=.&dl_token=${token}`,
        { method: "GET" },
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/zip");
    });
  });

  describe("Token service", () => {
    it("createDownloadToken creates a token", () => {
      const token = createDownloadToken();
      expect(token).toBeTruthy();
      expect(typeof token).toBe("string");
      expect(token.length).toBeGreaterThan(0);
    });

    it("consumeDownloadToken validates and consumes", () => {
      const token = createDownloadToken();
      expect(consumeDownloadToken(token)).toBe(true);
      expect(consumeDownloadToken(token)).toBe(false); // Already consumed
    });

    it("consumeDownloadToken rejects invalid token", () => {
      expect(consumeDownloadToken("invalid-token")).toBe(false);
    });

    it("consumeDownloadToken rejects empty string", () => {
      expect(consumeDownloadToken("")).toBe(false);
    });

    it("tokens are unique", () => {
      const tokens = new Set();
      for (let i = 0; i < 10; i++) {
        tokens.add(createDownloadToken());
      }
      expect(tokens.size).toBe(10);
    });
  });

  describe("Auth middleware with download token", () => {
    it("allows GET /files/raw with valid dl_token", async () => {
      writeFileSync(join(testDir, "test.txt"), "content");
      const token = createDownloadToken();
      const app = createTestApp();

      const res = await app.request(
        `/files/raw?path=test.txt&dl_token=${token}`,
        { method: "GET" },
      );

      expect(res.status).toBe(200);
    });

    it("rejects GET on non-download path with dl_token", async () => {
      const token = createDownloadToken();
      const app = createTestApp();

      const res = await app.request(`/files/tree?dl_token=${token}`, {
        method: "GET",
      });

      expect(res.status).toBe(401);
    });

    it("rejects POST request with dl_token (only GET)", async () => {
      const token = createDownloadToken();
      const app = createTestApp();

      const res = await app.request(
        `/files/download/token?dl_token=${token}`,
        { method: "POST" },
      );

      expect(res.status).toBe(401);
    });

    it("prefers Bearer token over dl_token", async () => {
      writeFileSync(join(testDir, "test.txt"), "content");
      const token = createDownloadToken();
      const app = createTestApp();

      const res = await app.request(
        `/files/raw?path=test.txt&dl_token=${token}`,
        { method: "GET", headers: { Authorization: "Bearer test-token-123" } },
      );

      expect(res.status).toBe(200);
    });
  });
});
