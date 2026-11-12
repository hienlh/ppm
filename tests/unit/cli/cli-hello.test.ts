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
import { cliHelloRoutes } from "../../../src/server/routes/cli-hello.ts";
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
        return Response.json({ ok: true, data: { instanceId, dbFile: "ppm.db", proof: helloProof(token, nonce, instanceId) } });
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

describe("GET /api/cli/hello", () => {
  it("answers this server's id and database file with a proof only the token's holder can make", async () => {
    const app = new Hono().route("/api/cli", cliHelloRoutes);
    const res = await app.request(`/api/cli/hello?nonce=${NONCE}`);
    const { data } = await res.json() as { data: { instanceId: string; dbFile: string; proof: string } };
    expect(data.instanceId).toBe(serverInstanceId());
    expect(data.dbFile).toBe("ppm.db");
    expect(JSON.stringify(data)).not.toContain(TOKEN);
    expect(helloProofMatches(TOKEN, NONCE, data.instanceId, data.proof)).toBe(true);
    expect(helloProofMatches("other", NONCE, data.instanceId, data.proof)).toBe(false);
  });

  it("refuses a missing or malformed nonce", async () => {
    const app = new Hono().route("/api/cli", cliHelloRoutes);
    expect((await app.request("/api/cli/hello")).status).toBe(400);
    expect((await app.request("/api/cli/hello?nonce=short")).status).toBe(400);
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
