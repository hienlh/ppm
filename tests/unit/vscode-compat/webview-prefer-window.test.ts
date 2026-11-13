import { describe, it, expect } from "bun:test";
import { WindowService } from "../../../packages/vscode-compat/src/window.ts";
import { ProcessService } from "../../../packages/vscode-compat/src/process.ts";
import { createVscodeCompat } from "../../../packages/vscode-compat/src/index.ts";
import type { RpcClient } from "../../../packages/vscode-compat/src/types.ts";
import { RpcChannel } from "../../../src/services/extension-rpc.ts";
import { registerVscodeCompatHandlers } from "../../../src/services/extension-rpc-handlers.ts";
import { extensionWebSocket } from "../../../src/server/ws/extensions.ts";
import type { RpcMessage } from "../../../src/types/extension.ts";

function recordingRpc() {
  const requests: { method: string; params: unknown[] }[] = [];
  const timed: { method: string; timeoutMs: number; params: unknown[] }[] = [];
  const rpc: RpcClient = {
    async request<T>(method: string, ...params: unknown[]) { requests.push({ method, params }); return undefined as T; },
    async requestWithTimeout<T>(method: string, timeoutMs: number, ...params: unknown[]) {
      timed.push({ method, timeoutMs, params });
      return undefined as T;
    },
    notify() {},
  };
  return { rpc, requests, timed };
}

describe("createWebviewPanel preferWindow", () => {
  it("sends the flag when the extension asks for a window", () => {
    const { rpc, requests } = recordingRpc();
    new WindowService(rpc, "ext").createWebviewPanel("graph.view", "Graph", 1, { projectPath: "/p", preferWindow: true });
    expect(requests[0]).toEqual({
      method: "window:webview:create",
      params: ["ext-wv-1", "ext", "graph.view", "Graph", "/p", true],
    });
  });

  it("sends exactly what it always did when the flag is absent or false", () => {
    for (const options of [undefined, { projectPath: "/p" }, { projectPath: "/p", preferWindow: false }]) {
      const { rpc, requests } = recordingRpc();
      new WindowService(rpc, "ext").createWebviewPanel("graph.view", "Graph", 1, options);
      expect(requests[0]!.params).toEqual(["ext-wv-1", "ext", "graph.view", "Graph", options?.projectPath]);
    }
  });
});

describe("window:webview:create on the main thread", () => {
  async function broadcastFor(params: unknown[]): Promise<Record<string, unknown>> {
    const received: string[] = [];
    const ws = { data: { type: "ext" }, send: (data: string) => { received.push(data); } };
    extensionWebSocket.open(ws as never);
    try {
      const rpc = new RpcChannel((_msg: RpcMessage) => {});
      registerVscodeCompatHandlers(rpc);
      await rpc.handleMessage({ type: "request", id: 1, method: "window:webview:create", params });
      return JSON.parse(received.find((r) => r.includes("webview:create"))!);
    } finally {
      extensionWebSocket.close(ws as never);
    }
  }

  it("forwards preferWindow to the browsers", async () => {
    const msg = await broadcastFor(["p1", "ext", "graph.view", "Graph", undefined, true]);
    expect(msg.preferWindow).toBe(true);
  });

  it("leaves the message unchanged without it", async () => {
    const msg = await broadcastFor(["p1", "ext", "graph.view", "Graph", undefined]);
    expect("preferWindow" in msg).toBe(false);
    const truthy = await broadcastFor(["p1", "ext", "graph.view", "Graph", undefined, "yes"]);
    expect("preferWindow" in truthy).toBe(false);
  });
});

describe("process.spawn wait", () => {
  it("waits 30 s longer than the process may run", async () => {
    const { rpc, timed, requests } = recordingRpc();
    const proc = new ProcessService(rpc);
    await proc.spawn("git", ["log"], "/p", { timeout: 5 * 60_000 });
    await proc.spawn("git", ["status"], "/p");
    await proc.spawn("git", ["status"], "/p", { timeout: Number.NaN });
    expect(requests).toEqual([]);
    expect(timed.map((t) => t.timeoutMs)).toEqual([5 * 60_000 + 30_000, 60_000, 60_000]);
    expect(timed[0]!.params).toEqual(["git", ["log"], "/p", { timeout: 5 * 60_000 }]);
  });
});

describe("createVscodeCompat", () => {
  it("exposes globalStoragePath on the context and a ppm namespace", () => {
    const { rpc } = recordingRpc();
    const api = createVscodeCompat({ extensionId: "ext", extensionPath: "/x", storagePath: "/x/.storage", globalStoragePath: "/data/ext", rpc });
    expect(api._createContext().globalStoragePath).toBe("/data/ext");
    expect(typeof api.ppm).toBe("object");
  });

  it("falls back to storagePath when no data folder is given", () => {
    const { rpc } = recordingRpc();
    const api = createVscodeCompat({ extensionId: "ext", extensionPath: "/x", storagePath: "/x/.storage", rpc });
    expect(api._createContext().globalStoragePath).toBe("/x/.storage");
  });
});
