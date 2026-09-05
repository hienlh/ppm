import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, mkdirSync, cpSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { _resetPpmDir } from "../../../../src/services/ppm-dir.ts";
import { openTestDb, setDb } from "../../../../src/services/db.service.ts";
import { configService } from "../../../../src/services/config.service.ts";
import { getCloudflaredPath } from "../../../../src/services/cloudflared.service.ts";
import { globalWebSocket } from "../../../../src/server/ws/global.ts";
import { getLoginSnapshot, startLogin, cancelLogin } from "../../../../src/services/named-tunnel/cloudflared-login.service.ts";

// Synthetic fixture only — never the real ~/.cloudflared/cert.pem on this host.
// Uses the same shape as cloudflared-cert.test.ts's fixture, driven through the
// REAL cloudflared-cert.ts module via the TUNNEL_ORIGIN_CERT override it
// already supports — no module mocking, so this suite can't leak into (or be
// leaked into by) that file's own real-parser tests.
const FAKE_ZONE_ID = "a".repeat(32);
const FAKE_ACCOUNT_ID = "b".repeat(32);
const FAKE_API_TOKEN = "fake-token-not-a-real-secret";

function pemWithPayload(payload: unknown): string {
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
  return `-----BEGIN ARGO TUNNEL TOKEN-----\n${b64}\n-----END ARGO TUNNEL TOKEN-----\n`;
}

/** Captures every event broadcast on /ws/global via a fake connected client — real module, no mocking. */
let openFakeClient: { data: { type: string }; send: (raw: string) => void } | null = null;
function captureBroadcasts(): unknown[] {
  const captured: unknown[] = [];
  openFakeClient = { data: { type: "global" }, send: (raw: string) => captured.push(JSON.parse(raw)) };
  globalWebSocket.open(openFakeClient as any);
  return captured;
}

/**
 * Places a real, harmless executable at the exact path `ensureCloudflared()`
 * expects, so the "shortcut correctly falls through" path can spawn a REAL
 * (but trivial and instant) process instead of either downloading a real
 * cloudflared binary or module-mocking `cloudflared.service.ts` (which has
 * its own real test elsewhere in the suite).
 */
function installFakeCloudflaredBinary(): void {
  const path = getCloudflaredPath();
  mkdirSync(dirname(path), { recursive: true });
  cpSync(process.execPath, path);
  if (process.platform !== "win32") chmodSync(path, 0o755);
}

const originalFetch = globalThis.fetch;

/**
 * Windows keeps an executable file locked for a moment after the process
 * running it is killed — `taskkill /F` requests termination but doesn't wait
 * for the OS to release the file handle, so an immediate `rmSync` on the
 * fake-binary's temp dir can race that teardown with EACCES. Best-effort
 * retry rather than a fixed sleep on every test.
 */
async function rmSyncRetrying(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (e: any) {
      if (e?.code !== "EACCES" && e?.code !== "EBUSY") throw e;
      await Bun.sleep(150);
    }
  }
  rmSync(path, { recursive: true, force: true });
}

describe("cloudflared-login.service", () => {
  let ppmHome: string;
  let certDir: string;

  beforeEach(() => {
    ppmHome = mkdtempSync(resolve(tmpdir(), "ppm-nt-login-"));
    process.env.PPM_HOME = ppmHome;
    _resetPpmDir();
    certDir = mkdtempSync(resolve(tmpdir(), "ppm-nt-login-cert-"));
    process.env.TUNNEL_ORIGIN_CERT = resolve(certDir, "cert.pem");

    setDb(openTestDb());
    configService.load();
  });

  afterEach(async () => {
    // Kill/clear any session left running by a fallthrough/relogin test —
    // otherwise its 60s/300s timers and live process outlive this test.
    cancelLogin();
    if (openFakeClient) {
      globalWebSocket.close(openFakeClient as any);
      openFakeClient = null;
    }
    delete process.env.PPM_HOME;
    delete process.env.TUNNEL_ORIGIN_CERT;
    _resetPpmDir();
    await rmSyncRetrying(ppmHome);
    await rmSyncRetrying(certDir);
    globalThis.fetch = originalFetch;
  });

  test("idle by default", () => {
    expect(getLoginSnapshot()).toEqual({ state: "idle", url: null, message: null });
  });

  test("cert parsed + live verify success + no pin conflict: success with no spawn", async () => {
    writeFileSync(process.env.TUNNEL_ORIGIN_CERT!, pemWithPayload({ zoneID: FAKE_ZONE_ID, accountID: FAKE_ACCOUNT_ID, apiToken: FAKE_API_TOKEN }));
    globalThis.fetch = (async () => new Response(JSON.stringify({ success: true }), { status: 200 })) as typeof fetch;
    // No fake binary installed — if the shortcut wrongly fell through to a
    // spawn attempt, ensureCloudflared would try a real network download and
    // this test would hang/fail instead of silently passing.

    const snapshot = await startLogin();
    expect(snapshot).toEqual({ state: "success", url: null, message: "already logged in" });
  });

  test("cert parsed but pinned zoneID/accountID differ: falls through to a fresh spawn attempt", async () => {
    writeFileSync(process.env.TUNNEL_ORIGIN_CERT!, pemWithPayload({ zoneID: FAKE_ZONE_ID, accountID: FAKE_ACCOUNT_ID, apiToken: FAKE_API_TOKEN }));
    configService.set("tunnel", {
      mode: "named",
      namedTunnelToken: "tok", namedTunnelHostname: "ppm.example.com",
      zoneID: "c".repeat(32), accountID: "d".repeat(32), // different from the cert
    });
    globalThis.fetch = (async () => new Response(JSON.stringify({ success: true }), { status: 200 })) as typeof fetch;
    installFakeCloudflaredBinary();

    const snapshot = await startLogin();
    expect(snapshot.state).not.toBe("success"); // shortcut correctly refused the mismatch
  }, 15_000);

  test("relogin renames an existing cert.pem aside before attempting a fresh login", async () => {
    writeFileSync(process.env.TUNNEL_ORIGIN_CERT!, "old cert contents");
    installFakeCloudflaredBinary();

    await startLogin({ relogin: true });

    expect(existsSync(process.env.TUNNEL_ORIGIN_CERT!)).toBe(false);
    const backups = readdirSync(certDir).filter((f) => f.startsWith("cert.pem.bak-"));
    expect(backups).toHaveLength(1);
  }, 15_000);

  test("cancelLogin with no live session still transitions to cancelled and broadcasts", () => {
    const captured = captureBroadcasts();
    cancelLogin();
    expect(getLoginSnapshot().state).toBe("cancelled");
    expect(captured.some((e: any) => e.type === "tunnel:login_state" && e.state === "cancelled")).toBe(true);
  });
});
