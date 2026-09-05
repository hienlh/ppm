import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { waitForLogLine } from "../../../../src/services/named-tunnel/named-tunnel-readiness.ts";

const READY_LINE = "Registered tunnel connection\n";
const notExited = () => null;

describe("waitForLogLine", () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "ppm-nt-readiness-"));
    logPath = resolve(dir, "cloudflared.log");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("times out when the only match sits before the offset (stale prior-generation content)", async () => {
    writeFileSync(logPath, READY_LINE);
    const offset = statSync(logPath).size; // offset AFTER the stale line
    await expect(
      waitForLogLine(logPath, /Registered tunnel connection/, {
        fromByteOffset: offset,
        timeoutMs: 300,
        pollIntervalMs: 50,
        getExitCode: notExited,
      }),
    ).rejects.toThrow(/timeout/);
  });

  test("matches a line appended after the offset within one poll interval", async () => {
    writeFileSync(logPath, "some earlier noise\n");
    const offset = statSync(logPath).size;
    setTimeout(() => appendFileSync(logPath, READY_LINE), 60);
    const match = await waitForLogLine(logPath, /Registered tunnel connection/, {
      fromByteOffset: offset,
      timeoutMs: 2000,
      pollIntervalMs: 50,
      getExitCode: notExited,
    });
    expect(match).toBe("Registered tunnel connection");
  });

  test("throws immediately once the process has exited without a match", async () => {
    writeFileSync(logPath, "");
    await expect(
      waitForLogLine(logPath, /Registered tunnel connection/, {
        fromByteOffset: 0,
        timeoutMs: 5000,
        pollIntervalMs: 20,
        getExitCode: () => 1,
      }),
    ).rejects.toThrow(/exited without matching/);
  });

  test("times out when the log file never appears", async () => {
    await expect(
      waitForLogLine(resolve(dir, "never-created.log"), /anything/, {
        fromByteOffset: 0,
        timeoutMs: 200,
        pollIntervalMs: 50,
        getExitCode: notExited,
      }),
    ).rejects.toThrow(/timeout/);
  });

  test("byte offset excludes a multi-byte UTF-8 line written before it", async () => {
    writeFileSync(logPath, "café ☕ pré-offset noise\n", "utf8");
    const offset = statSync(logPath).size;
    appendFileSync(logPath, "café ☕ Registered tunnel connection\n", "utf8");
    const match = await waitForLogLine(logPath, /Registered tunnel connection/, {
      fromByteOffset: offset,
      timeoutMs: 500,
      pollIntervalMs: 50,
      getExitCode: notExited,
    });
    expect(match).toBe("Registered tunnel connection");
  });
});
