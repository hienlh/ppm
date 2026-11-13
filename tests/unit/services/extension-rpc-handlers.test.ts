import { describe, it, expect, beforeEach } from "bun:test";
import { RpcChannel } from "../../../src/services/extension-rpc.ts";
import { registerVscodeCompatHandlers, spawnTimeoutMs, MAX_SPAWN_TIMEOUT_MS } from "../../../src/services/extension-rpc-handlers.ts";
import { configService } from "../../../src/services/config.service.ts";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { extensionWebSocket } from "../../../src/server/ws/extensions.ts";
import type { RpcMessage, RpcResponse } from "../../../src/types/extension.ts";

/** Round-trips one `workspace:config:get` request through a real RpcChannel wired to
 *  the real handler — proves the RPC boundary itself redacts, not just the underlying
 *  `redactSecretConfigValue` helper (already covered in config-secret-keys.test.ts). */
async function rpcGet(key: string): Promise<unknown> {
  const sent: RpcMessage[] = [];
  const channel = new RpcChannel((msg) => sent.push(msg));
  registerVscodeCompatHandlers(channel);
  await channel.handleMessage({ type: "request", id: 1, method: "workspace:config:get", params: [key] });
  const response = sent[0] as RpcResponse;
  if (response.error) throw new Error(response.error);
  return response.result;
}

beforeEach(() => {
  setDb(openTestDb());
  configService.load();
});

describe("workspace:config:get — secret masking over the RPC boundary", () => {
  it("returns null for a leaf secret key — no signal beyond 'not present'", async () => {
    configService.set("tunnel", { mode: "quick", namedTunnelToken: "s3cr3t-run-token" } as any);
    const result = await rpcGet("tunnel.namedTunnelToken");
    expect(result).toBeNull();
  });

  it("redacts the token inside an ANCESTOR object result ('tunnel'), keeps siblings", async () => {
    configService.set("tunnel", {
      mode: "named",
      namedTunnelHostname: "ppm.example.com",
      namedTunnelToken: "s3cr3t-run-token",
      zoneID: "a".repeat(32),
      accountID: "b".repeat(32),
    } as any);

    const result = await rpcGet("tunnel") as Record<string, unknown>;
    expect(result.namedTunnelToken).toBe("[REDACTED]");
    expect(result.mode).toBe("named");
    expect(result.namedTunnelHostname).toBe("ppm.example.com");
    expect(JSON.stringify(result)).not.toContain("s3cr3t-run-token");
  });

  it("redacts the token inside 'auth' the same way", async () => {
    configService.set("auth", { enabled: true, token: "s3cr3t-auth-token" } as any);
    const result = await rpcGet("auth") as Record<string, unknown>;
    expect(result.token).toBe("[REDACTED]");
    expect(result.enabled).toBe(true);
  });

  it("returns the real value for an unrelated key", async () => {
    configService.set("tunnel", { mode: "quick" } as any);
    expect(await rpcGet("tunnel.mode")).toBe("quick");
  });
});

describe("window:showComposer", () => {
  it("fails fast with undefined when no browser tab is connected", async () => {
    const sent: RpcMessage[] = [];
    const channel = new RpcChannel((msg) => sent.push(msg));
    registerVscodeCompatHandlers(channel);

    const start = performance.now();
    await channel.handleMessage({ type: "request", id: 1, method: "window:showComposer", params: [{}] });
    const elapsed = performance.now() - start;

    const response = sent[0] as RpcResponse;
    expect(response.error).toBeUndefined();
    expect(response.result).toBeUndefined();
    // The real call would otherwise sit on the 600s browser-side timeout — anything
    // but an instant return here means the fail-fast branch was skipped.
    expect(elapsed).toBeLessThan(500);
  });

  it("round-trips through a connected browser tab and broadcasts composer:dismiss on resolve", async () => {
    const received: string[] = [];
    const ws = { data: { type: "ext" }, send: (data: string) => { received.push(data); } };
    extensionWebSocket.open(ws as any);

    try {
      const sent: RpcMessage[] = [];
      const channel = new RpcChannel((msg) => sent.push(msg));
      registerVscodeCompatHandlers(channel);

      const callPromise = channel.handleMessage({
        type: "request", id: 1, method: "window:showComposer", params: [{ title: "Debug" }],
      });

      // The handler broadcasts composer:show synchronously (before its first await),
      // so by here the fake browser tab has already "seen" the dialog open.
      const shown = JSON.parse(received[0]!);
      expect(shown.type).toBe("composer:show");
      expect(shown.options).toEqual({ title: "Debug" });

      // Simulate the user sending from that tab.
      extensionWebSocket.message(ws as any, JSON.stringify({
        type: "composer:resolve",
        requestId: shown.requestId,
        result: { content: "hi", permissionMode: "bypassPermissions" },
      }));
      await callPromise;

      const response = sent[0] as RpcResponse;
      expect(response.result).toEqual({ content: "hi", permissionMode: "bypassPermissions" });

      // This same round trip must close the dialog everywhere, including this tab —
      // a prompt authored in one tab must not linger open in the rest.
      const dismiss = JSON.parse(received[1]!);
      expect(dismiss).toEqual({ type: "composer:dismiss", requestId: shown.requestId });
    } finally {
      extensionWebSocket.close(ws as any);
    }
  });
});

/** One request through a real channel; answers with the response instead of throwing. */
async function rpcCall(method: string, params: unknown[]): Promise<RpcResponse> {
  const sent: RpcMessage[] = [];
  const channel = new RpcChannel((msg) => sent.push(msg));
  registerVscodeCompatHandlers(channel);
  await channel.handleMessage({ type: "request", id: 1, method, params });
  return sent[0] as RpcResponse;
}

describe("process:spawn allowlist", () => {
  it("lets gh past the allowlist: a run or a spawn failure, never a refusal", async () => {
    // Whether gh is installed on this machine or not, the refusal must not be the answer.
    const response = await rpcCall("process:spawn", ["gh", ["--version"], process.cwd(), { timeout: 5_000 }]);
    expect(response.error ?? "").not.toContain("not allowed");
    if (response.error) expect(response.error).toContain("process:spawn failed");
  });

  it("still refuses a binary that is not on the list", async () => {
    const response = await rpcCall("process:spawn", ["curl", ["https://example.com"], process.cwd()]);
    expect(response.error).toContain("not allowed");
  });
});

describe("spawnTimeoutMs", () => {
  it("defaults to 30 s for missing or nonsense values", () => {
    for (const v of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, "60000"]) {
      expect(spawnTimeoutMs(v)).toBe(30_000);
    }
  });

  it("keeps a reasonable value and caps a huge one at 15 minutes", () => {
    expect(spawnTimeoutMs(45_000)).toBe(45_000);
    expect(spawnTimeoutMs(10 * 60 * 60_000)).toBe(MAX_SPAWN_TIMEOUT_MS);
    expect(MAX_SPAWN_TIMEOUT_MS).toBe(900_000);
  });
});
