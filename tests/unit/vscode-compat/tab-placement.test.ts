/**
 * An extension asks for a chat (or any tab) in a floating window beside one of its panels.
 * The panel object stays in the worker; only its id travels, and only a literal
 * `preferWindow: true` makes the request differ from what it always sent.
 */
import { describe, it, expect } from "bun:test";
import { WindowService } from "../../../packages/vscode-compat/src/window.ts";
import { createPpmChat } from "../../../packages/vscode-compat/src/ppm/ppm-chat.ts";
import type { RpcClient } from "../../../packages/vscode-compat/src/types.ts";
import { RpcChannel } from "../../../src/services/extension-rpc.ts";
import { registerVscodeCompatHandlers } from "../../../src/services/extension-rpc-handlers.ts";
import { parseTabPlacement } from "../../../src/services/extension-api/extension-tab-placement.ts";
import { extensionWebSocket } from "../../../src/server/ws/extensions.ts";
import type { RpcMessage } from "../../../src/types/extension.ts";

function recordingRpc() {
  const requests: { method: string; params: unknown[] }[] = [];
  const rpc: RpcClient = {
    async request<T>(method: string, ...params: unknown[]) { requests.push({ method, params }); return undefined as T; },
    async requestWithTimeout<T>(method: string, _timeoutMs: number, ...params: unknown[]) { requests.push({ method, params }); return undefined as T; },
    notify() {},
  };
  return { rpc, requests };
}

describe("placement on the worker side", () => {
  it("names the calling panel by its id in window.openTab and ppm.chat.openTab", async () => {
    const { rpc, requests } = recordingRpc();
    const windowApi = new WindowService(rpc, "ext");
    const panel = windowApi.createWebviewPanel("graph.view", "Graph", 1, { preferWindow: true });
    await windowApi.openTab("chat", "Chat", "proj", { sessionId: "s1" }, { preferWindow: true, beside: panel });
    await createPpmChat(rpc, "ext").openTab("s1", { preferWindow: true, beside: panel });

    const open = requests.find((r) => r.method === "window:openTab")!;
    expect(open.params).toEqual(["chat", "Chat", "proj", { sessionId: "s1" }, { preferWindow: true, besidePanelId: "ext-wv-1" }]);
    const chat = requests.find((r) => r.method === "chat:openTab")!;
    expect(chat.params).toEqual([{ sessionId: "s1", extensionId: "ext", placement: { preferWindow: true, besidePanelId: "ext-wv-1" } }]);
  });

  it("sends exactly what it always did without preferWindow", async () => {
    const { rpc, requests } = recordingRpc();
    const windowApi = new WindowService(rpc, "ext");
    const panel = windowApi.createWebviewPanel("graph.view", "Graph", 1);
    await windowApi.openTab("chat", "Chat", "proj", { sessionId: "s1" });
    await windowApi.openTab("chat", "Chat", "proj", { sessionId: "s1" }, { preferWindow: false, beside: panel });
    await createPpmChat(rpc, "ext").openTab("s1");
    await createPpmChat(rpc, "ext").openTab("s1", { beside: panel });

    const opens = requests.filter((r) => r.method === "window:openTab").map((r) => r.params);
    expect(opens).toEqual([["chat", "Chat", "proj", { sessionId: "s1" }], ["chat", "Chat", "proj", { sessionId: "s1" }]]);
    const chats = requests.filter((r) => r.method === "chat:openTab").map((r) => r.params);
    expect(chats).toEqual([[{ sessionId: "s1", extensionId: "ext" }], [{ sessionId: "s1", extensionId: "ext" }]]);
  });

  it("asks for a window with no anchor when `beside` is not one of its panels", async () => {
    const { rpc, requests } = recordingRpc();
    await createPpmChat(rpc, "ext").openTab("s1", { preferWindow: true, beside: { id: "forged" } });
    expect(requests[0]!.params).toEqual([{ sessionId: "s1", extensionId: "ext", placement: { preferWindow: true } }]);
  });
});

describe("placement on the main thread", () => {
  it("keeps only a literal preferWindow and a short printable panel id", () => {
    expect(parseTabPlacement(undefined)).toBeUndefined();
    expect(parseTabPlacement({ preferWindow: "yes" })).toBeUndefined();
    expect(parseTabPlacement({ preferWindow: true })).toEqual({ preferWindow: true });
    expect(parseTabPlacement({ preferWindow: true, besidePanelId: "ext-wv-2" })).toEqual({ preferWindow: true, besidePanelId: "ext-wv-2" });
    for (const bad of ["", "a b", "x".repeat(257), 42, "line\nbreak"]) {
      expect(parseTabPlacement({ preferWindow: true, besidePanelId: bad })).toEqual({ preferWindow: true });
    }
  });

  async function tabOpenFor(params: unknown[]): Promise<Record<string, unknown>> {
    const received: string[] = [];
    const ws = { data: { type: "ext" }, send: (data: string) => { received.push(data); } };
    extensionWebSocket.open(ws as never);
    try {
      const rpc = new RpcChannel((_msg: RpcMessage) => {});
      registerVscodeCompatHandlers(rpc);
      await rpc.handleMessage({ type: "request", id: 1, method: "window:openTab", params });
      return JSON.parse(received.find((r) => r.includes("tab:open"))!);
    } finally {
      extensionWebSocket.close(ws as never);
    }
  }

  it("forwards window:openTab's placement to the browsers, and nothing without one", async () => {
    const placed = await tabOpenFor(["chat", "Chat", "proj", { sessionId: "s1" }, { preferWindow: true, besidePanelId: "ext-wv-1", extra: 1 }]);
    expect(placed.placement).toEqual({ preferWindow: true, besidePanelId: "ext-wv-1" });
    const plain = await tabOpenFor(["chat", "Chat", "proj", { sessionId: "s1" }]);
    expect("placement" in plain).toBe(false);
  });
});
