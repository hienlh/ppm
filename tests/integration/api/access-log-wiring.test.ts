/**
 * The access log as the real server mounts it: ahead of authentication, so a request that is
 * refused is on record too — which also makes it the one log line a client that never signed
 * in can put words into. That line must stay one line and carry no credential.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import "../../test-setup.ts";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configService } from "../../../src/services/config.service.ts";
import { app } from "../../../src/server/index.ts";
import { installFileLogSink, _resetLoggerForTests } from "../../../src/services/logger.ts";
import { STDIO_IS_LOG_ENV } from "../../../src/services/log-rotate.ts";

describe("access log in the server", () => {
  const previousAuth = structuredClone(configService.get("auth"));
  let dir: string;
  let logPath: string;
  let uninstall = () => {};

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ppm-access-wiring-"));
    logPath = join(dir, "ppm.log");
    configService.set("auth", { ...previousAuth, enabled: true, token: "access-wiring-token" });
    _resetLoggerForTests();
    process.env[STDIO_IS_LOG_ENV] = "1"; // no echo
    uninstall = installFileLogSink({ echo: "console", path: logPath });
  });

  afterAll(() => {
    uninstall();
    delete process.env[STDIO_IS_LOG_ENV];
    _resetLoggerForTests();
    configService.set("auth", previousAuth);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("records a refused request on one line, without the credentials in its query", async () => {
    const forged = "[2026-10-06T00:00:00.000Z] [ERROR] [auth] forged";
    const res = await app.request(`/api/settings?code=c0de&state=st4te&q=${encodeURIComponent(`x\n${forged}`)}`);
    expect(res.status).toBe(401);

    const lines = existsSync(logPath) ? readFileSync(logPath, "utf8").trimEnd().split("\n") : [];
    const http = lines.filter((l) => l.includes("] [http] "));
    expect(http).toHaveLength(1);
    expect(http[0]).toContain(`[WARN] [http] GET /api/settings?code=[REDACTED]&state=[REDACTED]&q=x\\n${forged} 401`);
    expect(lines.join("\n")).not.toContain("c0de");
    expect(lines.join("\n")).not.toContain("st4te");
    // No line of the file is the caller's record.
    expect(lines.filter((l) => l.startsWith("[2026-10-06T00:00:00.000Z]"))).toEqual([]);
  });
});
