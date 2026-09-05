import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { openTestDb, setDb, setConfigValue } from "../../../src/services/db.service.ts";
import { tunnelRoutes } from "../../../src/server/routes/tunnel.ts";
import { configService } from "../../../src/services/config.service.ts";
import { tunnelService } from "../../../src/services/tunnel.service.ts";

const FULL_NAMED = {
  mode: "named",
  namedTunnelName: "ppm-host",
  namedTunnelHostname: "ppm.hienle.tech",
  namedTunnelToken: "secret-token",
  zoneID: "a".repeat(32),
  accountID: "b".repeat(32),
};

function createApp() {
  return new Hono().route("/tunnel", tunnelRoutes);
}

/** Swap in a fake so the "gate does not block" assertions never spawn a real
 *  cloudflared process (startTunnel's real path hangs without the binary
 *  present in the test sandbox — the existing route test file notes the same
 *  constraint for the happy-path quick spawn). */
function stubStartTunnel(): { calls: number; restore: () => void } {
  const original = tunnelService.startTunnel.bind(tunnelService);
  const state = { calls: 0 };
  (tunnelService as unknown as { startTunnel: typeof tunnelService.startTunnel }).startTunnel =
    async () => { state.calls++; return "https://fake.trycloudflare.com"; };
  return {
    get calls() { return state.calls; },
    restore: () => {
      (tunnelService as unknown as { startTunnel: typeof tunnelService.startTunnel }).startTunnel = original;
    },
  } as { calls: number; restore: () => void };
}

beforeEach(() => {
  setDb(openTestDb());
  configService.load();
  tunnelService.stopTunnel();
});

describe("POST /tunnel/start — named mode gate", () => {
  it("returns 409 without touching tunnelService when config row is named", async () => {
    setConfigValue("tunnel", JSON.stringify(FULL_NAMED));
    const stub = stubStartTunnel();
    try {
      const app = createApp();
      const res = await app.request("/tunnel/start", { method: "POST" });
      expect(res.status).toBe(409);
      const json = await res.json() as any;
      expect(json.ok).toBe(false);
      // Proves the 409 short-circuits before ever reaching startTunnel — the
      // whole point of the guard (no second connector spawned).
      expect(stub.calls).toBe(0);
    } finally {
      stub.restore();
    }
  });

  it("mode:'quick' with named fields still present (disabled) does NOT gate", async () => {
    setConfigValue("tunnel", JSON.stringify({ ...FULL_NAMED, mode: "quick" }));
    const stub = stubStartTunnel();
    try {
      const app = createApp();
      const res = await app.request("/tunnel/start", { method: "POST" });
      expect(res.status).not.toBe(409);
      expect(stub.calls).toBe(1);
    } finally {
      stub.restore();
    }
  });

  it("no tunnel config row at all does NOT gate (byte-identical quick behavior)", async () => {
    const stub = stubStartTunnel();
    try {
      const app = createApp();
      const res = await app.request("/tunnel/start", { method: "POST" });
      expect(res.status).not.toBe(409);
      expect(stub.calls).toBe(1);
    } finally {
      stub.restore();
    }
  });
});
