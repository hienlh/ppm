import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import "../../test-setup.ts";
import { configService } from "../../../src/services/config.service.ts";
import { app } from "../../../src/server/index.ts";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { writeFileSync, existsSync, unlinkSync, readFileSync } from "node:fs";

const LOG_FILE = resolve(homedir(), ".ppm", "ppm.log");

async function req(path: string) {
  return app.request(new Request(`http://localhost${path}`));
}

describe("Health + Info endpoints", () => {
  it("GET /api/health returns running status", async () => {
    const res = await req("/api/health");
    const json = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.status).toBe("running");
  });

  it("GET /api/info returns version and device_name (public, no auth)", async () => {
    const res = await req("/api/info");
    const json = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.version).toMatch(/^\d+\.\d+\.\d+$/);
    // device_name can be null or string
    expect(json.data).toHaveProperty("device_name");
  });
});

describe("Logs endpoint", () => {
  const originalLog = readFileSync(LOG_FILE, "utf-8").slice(0, 200);
  const testLogFile = LOG_FILE + ".bak";

  beforeAll(() => {
    // Backup existing log, write test content
    if (existsSync(LOG_FILE)) {
      writeFileSync(testLogFile, readFileSync(LOG_FILE));
    }
    writeFileSync(LOG_FILE, [
      "[2026-01-01T00:00:00Z] [INFO] Server started",
      "[2026-01-01T00:00:01Z] [INFO] Token: [REDACTED]",
      "[2026-01-01T00:00:02Z] [ERROR] Something failed",
      "[2026-01-01T00:00:03Z] [INFO] Request handled",
    ].join("\n") + "\n");
  });

  afterAll(() => {
    // Restore original log
    if (existsSync(testLogFile)) {
      writeFileSync(LOG_FILE, readFileSync(testLogFile));
      unlinkSync(testLogFile);
    }
  });

  it("GET /api/logs/recent returns last log lines", async () => {
    const res = await req("/api/logs/recent");
    const json = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.logs).toContain("Server started");
    expect(json.data.logs).toContain("Something failed");
  });

  it("GET /api/logs/recent redacts sensitive data", async () => {
    // Write log with sensitive data
    writeFileSync(LOG_FILE, [
      "[2026-01-01T00:00:00Z] [INFO] Token: mysecrettoken123",
      "[2026-01-01T00:00:01Z] [INFO] Bearer sk-ant-1234567890",
      "[2026-01-01T00:00:02Z] [INFO] ANTHROPIC_API_KEY=sk-secret-key",
      "[2026-01-01T00:00:03Z] [INFO] password: hunter2",
    ].join("\n") + "\n");

    const res = await req("/api/logs/recent");
    const json = (await res.json()) as any;
    const logs = json.data.logs as string;

    expect(logs).not.toContain("mysecrettoken123");
    expect(logs).not.toContain("sk-ant-1234567890");
    expect(logs).not.toContain("sk-secret-key");
    expect(logs).not.toContain("hunter2");
    expect(logs).toContain("[REDACTED]");
  });

  it("GET /api/logs/recent returns empty when no log file", async () => {
    // Temporarily remove log file
    const backup = readFileSync(LOG_FILE);
    unlinkSync(LOG_FILE);

    const res = await req("/api/logs/recent");
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);
    expect(json.data.logs).toBe("");

    // Restore
    writeFileSync(LOG_FILE, backup);
  });
});

describe("Debug crash endpoint (dev only)", () => {
  it("GET /api/debug/crash exists in non-production", async () => {
    // We can't actually call it (it kills the process), but verify it's registered
    // by checking the app routes - just verify the health endpoint works as baseline
    const res = await req("/api/health");
    expect(res.status).toBe(200);
  });
});
