import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { Hono } from "hono";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { cloudflaredLoginService } from "../../../src/services/named-tunnel/cloudflared-login.service.ts";
import { namedTunnelSetupService, SetupError } from "../../../src/services/named-tunnel/named-tunnel-setup.service.ts";
import { namedTunnelRoutes } from "../../../src/server/routes/named-tunnel.ts";

// Monkey-patch the two service aggregates (NOT mock.module — module mocks
// leak across test files in bun and would poison the direct-function unit
// tests in cloudflared-login.service.test.ts / named-tunnel-setup.service.test.ts).
const originals = {
  getLoginSnapshot: cloudflaredLoginService.getLoginSnapshot,
  startLogin: cloudflaredLoginService.startLogin,
  cancelLogin: cloudflaredLoginService.cancelLogin,
  readZoneInfo: namedTunnelSetupService.readZoneInfo,
  runSetup: namedTunnelSetupService.runSetup,
  disableNamedTunnel: namedTunnelSetupService.disableNamedTunnel,
  currentCertState: namedTunnelSetupService.currentCertState,
};
afterAll(() => {
  Object.assign(cloudflaredLoginService, {
    getLoginSnapshot: originals.getLoginSnapshot,
    startLogin: originals.startLogin,
    cancelLogin: originals.cancelLogin,
  });
  Object.assign(namedTunnelSetupService, {
    readZoneInfo: originals.readZoneInfo,
    runSetup: originals.runSetup,
    disableNamedTunnel: originals.disableNamedTunnel,
    currentCertState: originals.currentCertState,
  });
});

// Shared mutable state the patched services read/write.
const state = {
  loginSnapshot: { state: "idle" as const, url: null as string | null, message: null as string | null },
  startLoginCalls: 0,
  cancelCalls: 0,
  disableCalls: 0,
  certState: "none" as "none" | "invalid" | "ok" | "mismatch",
  setupThrow: null as { status: number; message: string } | null,
  setupResult: { ok: true as const, hostname: "ppm.example.com", tunnelName: "ppm-host" } as any,
};

cloudflaredLoginService.getLoginSnapshot = () => state.loginSnapshot;
cloudflaredLoginService.startLogin = (async () => {
  state.startLoginCalls++;
  return state.loginSnapshot;
}) as typeof cloudflaredLoginService.startLogin;
cloudflaredLoginService.cancelLogin = () => {
  state.cancelCalls++;
};
namedTunnelSetupService.currentCertState = () => state.certState;
namedTunnelSetupService.readZoneInfo = async () => ({
  zone: "example.com", zoneID: "a".repeat(32), accountID: "b".repeat(32), proposedHostname: "ppm.example.com",
});
namedTunnelSetupService.runSetup = (async (hostname: string) => {
  if (state.setupThrow) throw new SetupError(state.setupThrow.status, state.setupThrow.message);
  return { ...state.setupResult, hostname };
}) as typeof namedTunnelSetupService.runSetup;
namedTunnelSetupService.disableNamedTunnel = async () => {
  state.disableCalls++;
};

function app() {
  return new Hono().route("/api/tunnel/named", namedTunnelRoutes);
}

function setAuth(enabled: boolean) {
  configService.set("auth", { enabled, token: "test-token" });
}

const FULL_NAMED_TUNNEL = {
  mode: "named" as const,
  namedTunnelName: "ppm-host",
  namedTunnelHostname: "ppm.example.com",
  namedTunnelToken: "a-very-long-run-token-that-must-never-leave-this-process-1234567890",
  zoneID: "a".repeat(32),
  accountID: "b".repeat(32),
};

beforeEach(() => {
  setDb(openTestDb());
  configService.load();
  state.loginSnapshot = { state: "idle", url: null, message: null };
  state.startLoginCalls = 0;
  state.cancelCalls = 0;
  state.disableCalls = 0;
  state.certState = "none";
  state.setupThrow = null;
  state.setupResult = { ok: true, hostname: "ppm.example.com", tunnelName: "ppm-host" };
});

describe("GET /api/tunnel/named/status", () => {
  it("never returns the raw token — only the masked form", async () => {
    configService.set("tunnel", FULL_NAMED_TUNNEL);
    const res = await app().request("/api/tunnel/named/status");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.mode).toBe("named");
    expect(json.data.tokenMasked).toBe("a-very...");
    const body = JSON.stringify(json);
    expect(body).not.toContain(FULL_NAMED_TUNNEL.namedTunnelToken);
  });

  it("reports certState and the live login snapshot", async () => {
    state.certState = "ok";
    state.loginSnapshot = { state: "waiting", url: "https://dash.cloudflare.com/argotunnel?x", message: null };
    const res = await app().request("/api/tunnel/named/status");
    const json = await res.json();
    expect(json.data.certState).toBe("ok");
    expect(json.data.login).toEqual(state.loginSnapshot);
  });

  it("works even when auth is disabled (read-mostly route)", async () => {
    setAuth(false);
    const res = await app().request("/api/tunnel/named/status");
    expect(res.status).toBe(200);
  });

  it("exposes authEnabled so the client can hide the popup on an auth-disabled install", async () => {
    setAuth(true);
    const enabledRes = await app().request("/api/tunnel/named/status");
    expect((await enabledRes.json()).data.authEnabled).toBe(true);

    setAuth(false);
    const disabledRes = await app().request("/api/tunnel/named/status");
    expect((await disabledRes.json()).data.authEnabled).toBe(false);
  });

  it("passes through a cert/pin mismatch as certState:'mismatch'", async () => {
    state.certState = "mismatch";
    const res = await app().request("/api/tunnel/named/status");
    const json = await res.json();
    expect(json.data.certState).toBe("mismatch");
  });
});

describe("POST /api/tunnel/named/dismiss", () => {
  it("works even when auth is disabled — must be silenceable pre-auth", async () => {
    setAuth(false);
    const res = await app().request("/api/tunnel/named/dismiss", { method: "POST" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.dismissed).toBe(true);
  });
});

describe("mutating routes — auth-disabled 403", () => {
  const cases: Array<[string, string]> = [
    ["/api/tunnel/named/login", "POST"],
    ["/api/tunnel/named/login/cancel", "POST"],
    ["/api/tunnel/named/setup", "POST"],
    ["/api/tunnel/named/disable", "POST"],
  ];

  for (const [path, method] of cases) {
    it(`${method} ${path} returns 403 when auth.enabled is false`, async () => {
      setAuth(false);
      const res = await app().request(path, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "POST" && path.endsWith("/setup") ? JSON.stringify({ hostname: "ppm.example.com" }) : undefined,
      });
      expect(res.status).toBe(403);
      expect(state.startLoginCalls).toBe(0);
      expect(state.cancelCalls).toBe(0);
      expect(state.disableCalls).toBe(0);
    });
  }
});

describe("mutating routes — cross-origin rejection", () => {
  it("rejects a POST /login carrying a foreign Origin header", async () => {
    setAuth(true);
    const res = await app().request("/api/tunnel/named/login", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(state.startLoginCalls).toBe(0);
  });

  it("allows a same-origin POST /login through to the service", async () => {
    setAuth(true);
    const res = await app().request("/api/tunnel/named/login", {
      method: "POST",
      headers: { origin: "http://localhost" },
    });
    expect(res.status).toBe(200);
    expect(state.startLoginCalls).toBe(1);
  });

  it("allows a POST with no Origin header at all (non-browser caller)", async () => {
    setAuth(true);
    const res = await app().request("/api/tunnel/named/disable", { method: "POST" });
    expect(res.status).toBe(200);
    expect(state.disableCalls).toBe(1);
  });
});

describe("POST /api/tunnel/named/setup", () => {
  it("rejects a missing hostname with 400, no service call", async () => {
    setAuth(true);
    const res = await app().request("/api/tunnel/named/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("propagates a SetupError's status and message from the service", async () => {
    setAuth(true);
    state.setupThrow = { status: 400, message: "that name already points somewhere else — pick another prefix" };
    const res = await app().request("/api/tunnel/named/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "taken.example.com" }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toContain("already points somewhere else");
  });

  it("returns the pending shape when the service reports ok:'pending'", async () => {
    setAuth(true);
    state.setupResult = { ok: "pending", tunnelName: "ppm-host", message: "run `ppm restart` to apply" };
    const res = await app().request("/api/tunnel/named/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "ppm.example.com" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.pending).toBe(true);
    expect(json.data.message).toContain("ppm restart");
  });

  it("returns the confirmed shape on ok:true", async () => {
    setAuth(true);
    const res = await app().request("/api/tunnel/named/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "ppm.example.com" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.hostname).toBe("ppm.example.com");
    expect(json.data.tunnelName).toBe("ppm-host");
    expect(json.data.pending).toBeUndefined();
  });
});

describe("GET /api/tunnel/named/zone", () => {
  it("stays reachable with auth disabled (read-mostly)", async () => {
    setAuth(false);
    const res = await app().request("/api/tunnel/named/zone");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.proposedHostname).toBe("ppm.example.com");
  });
});
