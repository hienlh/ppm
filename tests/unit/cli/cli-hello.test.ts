/**
 * The CLI's identity check: the public hello route proves the server holds the token without
 * revealing it, and a server that answers like PPM's health route but cannot prove it never
 * receives `Authorization`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { rmSync, writeFileSync } from "node:fs";
import { Hono } from "hono";
import { configService } from "../../../src/services/config.service.ts";
import { getDbPath } from "../../../src/services/db.service.ts";
import { cliHelloRoutes, cliHelloRoutesFor } from "../../../src/server/routes/cli-hello.ts";
import { _resetEdgeForwardedPorts, markEdgeForwardedPort } from "../../../src/server/routes/cli-hello-request-guard.ts";
import { corsHeaders } from "../../../src/server/middleware/cors-headers.ts";
import { helloProof, helloProofMatches } from "../../../src/services/cli-hello-proof.ts";
import { serverInstanceId } from "../../../src/services/server-instance-id.ts";
import { endpointFilePath, type ServerEndpoint } from "../../../src/services/server-endpoint-file.ts";
import { _resetServerClient, serverRequest, ServerRefusedError } from "../../../src/cli/utils/ppm-server-client.ts";

const TOKEN = "cli-hello-token";
const NONCE = "n".repeat(24);
const seen: { path: string; auth: string | null; aiChat: string | null; body: string }[] = [];
let server: ReturnType<typeof Bun.serve> | null = null;

/** A server that records every request and answers hello with a proof made from `token`. */
function recordingServer(instanceId: string, token: string): string {
  server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({ path: url.pathname, auth: req.headers.get("authorization"), aiChat: req.headers.get("x-ppm-ai-chat"), body: await req.text() });
      if (url.pathname === "/api/health") return Response.json({ ok: true, data: { status: "running", instanceId } });
      if (url.pathname === "/api/cli/hello") {
        const nonce = url.searchParams.get("nonce") ?? "";
        return Response.json({ ok: true, data: { instanceId, dbFile: "ppm.db", proof: helloProof(token, nonce, instanceId, Number(url.port)) } });
      }
      return Response.json({ ok: true, data: { done: true } });
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const e: ServerEndpoint = { pid: process.pid, baseUrl, instanceId, dbFile: "ppm.db", version: "t", startedAt: "" };
  writeFileSync(endpointFilePath(getDbPath()), JSON.stringify(e));
  return baseUrl;
}

beforeEach(() => {
  configService.set("auth", { enabled: true, token: TOKEN });
  configService.save();
  seen.length = 0;
  _resetServerClient();
});
afterEach(() => {
  server?.stop(true);
  server = null;
  rmSync(endpointFilePath(getDbPath()), { force: true });
  configService.set("auth", { enabled: false, token: "" });
  configService.save();
  delete process.env.PPM_AI_CHAT;
});

/** What `Bun.serve` hands Hono as `c.env`: the port the request came in on, and its peer. */
const serverEnv = (address = "127.0.0.1", port = 4321) => ({ port, requestIP: () => ({ address, family: "IPv4", port: 50000 }) });
const hello = (headers: Record<string, string> = {}, env: unknown = serverEnv(), routes = cliHelloRoutes) =>
  new Hono().use("*", corsHeaders).route("/api/cli", routes).request(`/api/cli/hello?nonce=${NONCE}`, { headers }, env);

describe("GET /api/cli/hello", () => {
  afterEach(() => _resetEdgeForwardedPorts());

  it("answers a direct loopback request with a proof only the token's holder can make, for the port it came in on", async () => {
    const res = await hello();
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("null");
    const { data } = await res.json() as { data: { instanceId: string; dbFile: string; proof: string } };
    expect(data.instanceId).toBe(serverInstanceId());
    expect(data.dbFile).toBe("ppm.db");
    expect(JSON.stringify(data)).not.toContain(TOKEN);
    expect(helloProofMatches(TOKEN, NONCE, data.instanceId, 4321, data.proof)).toBe(true);
    expect(helloProofMatches("other", NONCE, data.instanceId, 4321, data.proof)).toBe(false);
    // Relayed through a port of someone else's, the proof names the real one and fails there.
    expect(helloProofMatches(TOKEN, NONCE, data.instanceId, 4322, data.proof)).toBe(false);
  });

  it("refuses a page in a browser, a tunnel, a proxy and a peer off this machine, and says nothing a page can read", async () => {
    const refused: Array<[string, Record<string, string>, unknown]> = [
      ["origin", { Origin: "https://evil.example" }, serverEnv()],
      ["null origin", { Origin: "null" }, serverEnv()],
      ["fetch metadata", { "Sec-Fetch-Site": "cross-site" }, serverEnv()],
      ["cloudflared", { "CF-Connecting-IP": "203.0.113.9", "CF-Ray": "8a-SIN" }, serverEnv()],
      ["forwarded for", { "X-Forwarded-For": "203.0.113.9" }, serverEnv()],
      ["forwarded", { Forwarded: "for=203.0.113.9" }, serverEnv()],
      ["tailscale", { "Tailscale-User-Login": "someone@example.com" }, serverEnv()],
      ["lan peer", {}, serverEnv("192.168.1.20")],
      // A server that cannot say who is asking (no `requestIP`): not a request known to be local.
      ["unknown peer", {}, { port: 4321 }],
    ];
    for (const [label, headers, env] of refused) {
      const res = await hello(headers, env);
      const body = await res.text();
      expect({ label, status: res.status, proof: body.includes("proof") }).toEqual({ label, status: 403, proof: false });
      expect(res.headers.get("access-control-allow-origin")).toBe("null");
    }
  });

  it("refuses on the port the edge forwarder relays the network to, and answers on its own listener for that port", async () => {
    markEdgeForwardedPort(4321);
    expect((await hello()).status).toBe(403);
    const own = await hello({}, serverEnv("127.0.0.1", 5555), cliHelloRoutesFor(4321));
    const { data } = await own.json() as { data: { instanceId: string; proof: string } };
    expect(helloProofMatches(TOKEN, NONCE, data.instanceId, 4321, data.proof)).toBe(true);
  });

  it("refuses a missing or malformed nonce", async () => {
    const app = new Hono().route("/api/cli", cliHelloRoutes);
    expect((await app.request("/api/cli/hello", {}, serverEnv())).status).toBe(400);
    expect((await app.request("/api/cli/hello?nonce=short", {}, serverEnv())).status).toBe(400);
  });
});

describe("serverRequest", () => {
  it("never sends Authorization to a server that cannot prove it holds the token", async () => {
    recordingServer("forged", "not-the-token");
    await expect(serverRequest("PUT", "/settings/config-key", { key: "log_level", value: "debug" })).rejects.toBeInstanceOf(ServerRefusedError);
    expect(seen.map((s) => s.path)).toEqual(["/api/cli/hello"]);
    expect(seen.every((s) => s.auth === null)).toBe(true);
  });

  it("signs in to a server that proves it, sends a JSON body on every write, and marks an AI chat's call", async () => {
    recordingServer("real", TOKEN);
    process.env.PPM_AI_CHAT = "1";
    await serverRequest("POST", "/schedules/x/run-now");
    const call = seen.find((s) => s.path === "/api/schedules/x/run-now")!;
    expect(call.auth).toBe(`Bearer ${TOKEN}`);
    expect(call.body).toBe("{}");
    expect(call.aiChat).toBe("1");
    expect(seen.find((s) => s.path === "/api/cli/hello")!.auth).toBeNull();
  });

  it("refuses a write from an AI chat bound to another database before contacting anything", async () => {
    recordingServer("real", TOKEN);
    process.env.PPM_AI_CHAT = "1";
    process.env.PPM_ASSISTANT_DB = "/elsewhere/ppm.dev.db";
    try {
      await expect(serverRequest("PUT", "/settings/config-key", { key: "log_level", value: "debug" })).rejects.toThrow("belongs to the PPM on ppm.dev.db");
      expect(seen.filter((s) => s.path !== "/api/cli/hello")).toEqual([]);
    } finally {
      delete process.env.PPM_ASSISTANT_DB;
    }
  });
});
