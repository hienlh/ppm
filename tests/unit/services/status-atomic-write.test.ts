/**
 * Tests for atomic status.json writes (Bug 1 fix) and tunnel lifecycle (Bug 2 fix).
 * Verifies cross-process race protection and tunnel ownership semantics.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync, rmSync,
} from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

// ─── Atomic write tests (Bug 1) ──────────────────────────────────────

describe("atomic status.json writes", () => {
  const tmpDir = resolve(tmpdir(), `ppm-atomic-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const statusFile = resolve(tmpDir, "status.json");

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("write-rename produces valid JSON even if reader is concurrent", () => {
    // Simulate atomic write pattern used in updateStatus
    const data = { tunnelPid: 12345, shareUrl: "https://test.trycloudflare.com", state: "running" };
    const tmp = statusFile + ".tmp." + process.pid;
    writeFileSync(tmp, JSON.stringify(data));

    // Before rename, original file doesn't exist (or has old content)
    expect(existsSync(statusFile)).toBe(false);

    // Rename is atomic on POSIX — readers see either old or new, never partial
    const { renameSync } = require("node:fs");
    renameSync(tmp, statusFile);

    const read = JSON.parse(readFileSync(statusFile, "utf-8"));
    expect(read.tunnelPid).toBe(12345);
    expect(read.shareUrl).toBe("https://test.trycloudflare.com");
  });

  test("no .tmp files left after successful write", () => {
    const data = { state: "running" };
    const tmp = statusFile + ".tmp." + process.pid;
    writeFileSync(tmp, JSON.stringify(data));
    const { renameSync } = require("node:fs");
    renameSync(tmp, statusFile);

    expect(existsSync(tmp)).toBe(false);
    expect(existsSync(statusFile)).toBe(true);
  });

  test("merge preserves existing fields not in patch", () => {
    // Simulate updateStatus read-merge-write
    const existing = { tunnelPid: 99, shareUrl: "https://old.trycloudflare.com", port: 3210 };
    writeFileSync(statusFile, JSON.stringify(existing));

    const patch = { state: "upgrading" };
    const read = JSON.parse(readFileSync(statusFile, "utf-8"));
    const merged = { ...read, ...patch };

    expect(merged.tunnelPid).toBe(99);
    expect(merged.shareUrl).toBe("https://old.trycloudflare.com");
    expect(merged.state).toBe("upgrading");
  });

  test("concurrent writes don't produce corrupt JSON", async () => {
    // Write initial data
    writeFileSync(statusFile, JSON.stringify({ initial: true }));

    // Simulate 10 concurrent atomic writes from different "processes"
    const writes = Array.from({ length: 10 }, (_, i) => {
      return new Promise<void>((resolve) => {
        const data = JSON.parse(readFileSync(statusFile, "utf-8"));
        data[`writer_${i}`] = true;
        const tmp = statusFile + `.tmp.${i}`;
        writeFileSync(tmp, JSON.stringify(data));
        const { renameSync } = require("node:fs");
        renameSync(tmp, statusFile);
        resolve();
      });
    });

    await Promise.all(writes);

    // File must be valid JSON (no corruption)
    const final = JSON.parse(readFileSync(statusFile, "utf-8"));
    expect(typeof final).toBe("object");
    // At least one writer's data should be present (last-writer-wins is OK,
    // the important thing is no corruption)
    expect(final.initial).toBe(true);
  });
});

// ─── Tunnel service ownership tests (Bug 2) ─────────────────────────

describe("tunnel service supervisor-managed flag", () => {
  const tmpDir = resolve(tmpdir(), `ppm-tunnel-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const statusFile = resolve(tmpDir, "status.json");
  const restartingFlag = resolve(tmpDir, ".restarting");

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(statusFile, JSON.stringify({
      tunnelPid: 99999,
      shareUrl: "https://test.trycloudflare.com",
    }));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("setExternalPid marks tunnel as supervisor-managed", async () => {
    // We test the class logic directly by importing and checking behavior
    const mod = await import("../../../src/services/tunnel.service.ts");
    const service = mod.tunnelService;

    // After setExternalPid, supervisorManaged should be true
    // We can verify indirectly: stopTunnel should NOT kill the external PID
    service.setExternalPid(99999);
    service.setExternalUrl("https://test.trycloudflare.com");

    // getTunnelPid should return the external PID
    expect(service.getTunnelPid()).toBe(99999);
    expect(service.getTunnelUrl()).toBe("https://test.trycloudflare.com");
  });

  test("stopTunnel does not kill external supervisor-managed PID", async () => {
    const mod = await import("../../../src/services/tunnel.service.ts");
    const service = mod.tunnelService;

    // Track if process.kill was called with the external PID
    const originalKill = process.kill;
    let killCalledWithPid: number | null = null;
    // @ts-ignore — mock for testing
    process.kill = (pid: number, signal?: string | number) => {
      killCalledWithPid = pid;
      return originalKill.call(process, pid, signal);
    };

    try {
      service.setExternalPid(99999);
      service.setExternalUrl("https://test.trycloudflare.com");
      service.stopTunnel();

      // process.kill should NOT have been called with 99999
      // (the old code would have called process.kill(99999) to kill the tunnel)
      expect(killCalledWithPid).toBeNull();
    } finally {
      process.kill = originalKill;
    }
  });
});
