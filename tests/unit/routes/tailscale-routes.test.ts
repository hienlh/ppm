import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { configService } from "../../../src/services/config.service.ts";
import { tailscaleAppService, TailscaleServiceError } from "../../../src/services/tailscale/tailscale-app-service.ts";
import { tailscaleLoginService } from "../../../src/services/tailscale/tailscale-login.ts";
import { tailscaleRoutes } from "../../../src/server/routes/tailscale.ts";
import type { TailscaleLoginSnapshot, TailscaleSetupState } from "../../../src/shared/tailscale-setup.ts";

// Patch the two service aggregates rather than mock.module, which leaks across test files.
const originals = { ...tailscaleAppService, ...tailscaleLoginService };
afterAll(() => {
  Object.assign(tailscaleAppService, {
    readState: originals.readState,
    enableService: originals.enableService,
    disableService: originals.disableService,
    renameService: originals.renameService,
  });
  Object.assign(tailscaleLoginService, {
    getLoginSnapshot: originals.getLoginSnapshot,
    startLogin: originals.startLogin,
    cancelLogin: originals.cancelLogin,
  });
});

const setup = (enabled: boolean): TailscaleSetupState => ({
  installed: true, backendState: "Running", canManage: true, osUser: "dev", platform: "linux",
  tailnet: "user@example.com", dnsSuffix: "tail1234.ts.net", magicDns: true, httpsCertificates: true,
  device: { name: "devbox", dnsName: "devbox.tail1234.ts.net", ips: ["100.64.0.7"], tags: ["tag:server"] },
  service: { name: "ppm", url: "https://ppm.tail1234.ts.net/", defined: true, approved: true, advertised: enabled, target: null, pointsAtPpm: enabled },
  enabled, ppmPort: 8080,
});

let calls: unknown[][];
let login: TailscaleLoginSnapshot;
let failWith: TailscaleServiceError | null;

tailscaleAppService.readState = async (name?: string) => { calls.push(["readState", name]); return setup(false); };
tailscaleAppService.enableService = async (opts) => {
  calls.push(["enable", opts]);
  if (failWith) throw failWith;
  return setup(true);
};
tailscaleAppService.disableService = async () => { calls.push(["disable"]); return setup(false); };
tailscaleAppService.renameService = async (name: string) => { calls.push(["rename", name]); return setup(false); };
tailscaleLoginService.getLoginSnapshot = () => login;
tailscaleLoginService.startLogin = async () => {
  calls.push(["startLogin"]);
  login = { state: "waiting", url: "https://login.tailscale.com/a/fake", message: null };
  return login;
};
tailscaleLoginService.cancelLogin = () => { calls.push(["cancelLogin"]); return { state: "cancelled", url: null, message: null }; };

const app = () => new Hono().route("/api/tailscale", tailscaleRoutes);
const post = (path: string, body?: unknown, origin?: string) =>
  app().request(`http://localhost:8081/api/tailscale${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

let authBefore: ReturnType<typeof configService.get<"auth">>;
beforeEach(() => {
  calls = [];
  login = { state: "idle", url: null, message: null };
  failWith = null;
  authBefore ??= configService.get("auth");
  configService.set("auth", { ...authBefore, enabled: true, token: "test-token" });
});
afterAll(() => configService.set("auth", authBefore));

it("GET /api/tailscale/state adds what only PPM knows", async () => {
  login = { state: "waiting", url: "https://login.tailscale.com/a/fake", message: null };
  const json = await (await app().request("/api/tailscale/state")).json();
  expect(calls).toEqual([["readState", undefined]]);
  expect(json.data).toMatchObject({ backendState: "Running", login, authEnabled: true });
});

describe("POST /api/tailscale/service", () => {
  it("routes on, off and rename", async () => {
    expect((await (await post("/service", { enabled: true, name: "ppm", replace: true })).json()).data.enabled).toBe(true);
    await post("/service", { enabled: false });
    await post("/service", { name: "ppm-dev" });
    expect(calls).toEqual([["enable", { name: "ppm", replace: true }], ["disable"], ["rename", "ppm-dev"]]);
  });

  it("answers with the service's own status and message", async () => {
    failWith = new TailscaleServiceError("svc:ppm already serves http://127.0.0.1:8000. Choose another name, or replace it.", 409, "conflict");
    const res = await post("/service", { enabled: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: expect.stringContaining("already serves"), code: "conflict" });
  });

  it("refuses a body that asks for nothing", async () => {
    expect((await post("/service", {})).status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe("cross-origin requests", () => {
  it("are refused before anything runs", async () => {
    for (const path of ["/service", "/login", "/login/cancel"]) {
      expect((await post(path, { enabled: false }, "https://evil.example")).status).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  it("from the same host on another port (the dev proxy) go through", async () => {
    expect((await post("/service", { enabled: false }, "http://localhost:5173")).status).toBe(200);
  });
});

it("starts and cancels a sign-in", async () => {
  expect((await (await post("/login")).json()).data).toMatchObject({ state: "waiting", url: "https://login.tailscale.com/a/fake" });
  expect((await (await post("/login/cancel")).json()).data.state).toBe("cancelled");
  expect(calls).toEqual([["startLogin"], ["cancelLogin"]]);
});
