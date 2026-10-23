import { describe, it, expect, spyOn, afterEach } from "bun:test";
import { RpcChannel } from "../../../src/services/extension-rpc.ts";
import { registerVscodeCompatHandlers } from "../../../src/services/extension-rpc-handlers.ts";
import { extensionApiDeps } from "../../../src/services/extension-api/index.ts";
import { ExtensionCallRegistry } from "../../../src/services/extension-api/extension-call-registry.ts";
import { extensionWebSocket } from "../../../src/server/ws/extensions.ts";
import type { RpcMessage, RpcResponse } from "../../../src/types/extension.ts";

/** One RPC request a worker would send for each dialog, and the messages the browser sees. */
const DIALOGS = [
  { method: "window:showQuickPick", params: [[{ label: "a" }], {}], show: "quickpick:show", dismiss: "quickpick:dismiss", answer: (requestId: string) => ({ type: "quickpick:resolve", requestId, selected: [{ label: "a" }] }), result: [{ label: "a" }] },
  { method: "window:showInputBox", params: [{ prompt: "name" }], show: "inputbox:show", dismiss: "inputbox:dismiss", answer: (requestId: string) => ({ type: "inputbox:resolve", requestId, value: "typed" }), result: "typed" },
  { method: "window:showComposer", params: [{}], show: "composer:show", dismiss: "composer:dismiss", answer: (requestId: string) => ({ type: "composer:resolve", requestId, result: { content: "hi", permissionMode: "default" } }), result: { content: "hi", permissionMode: "default" } },
] as const;

/** A connected browser tab, the channel the worker's requests arrive on, and its generation. */
function setUp(generation = 1) {
  const received: { type: string; requestId?: string }[] = [];
  const ws = { data: { type: "ext" }, send: (data: string) => { received.push(JSON.parse(data)); } };
  extensionWebSocket.open(ws as any);
  const sent: RpcMessage[] = [];
  const channel = new RpcChannel((msg) => sent.push(msg));
  const registry = new ExtensionCallRegistry();
  registerVscodeCompatHandlers(channel, extensionApiDeps(generation, registry));
  return { ws, received, sent, channel, registry, close: () => extensionWebSocket.close(ws as any) };
}

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; });

describe("extension dialogs shown in the browser", () => {
  for (const dialog of DIALOGS) {
    it(`${dialog.method} waits as long as the worker does (600 s), not the 30 s default`, async () => {
      const t = setUp();
      cleanup = t.close;
      const timers = spyOn(globalThis, "setTimeout");
      try {
        const call = t.channel.handleMessage({ type: "request", id: 1, method: dialog.method, params: [...dialog.params] });
        const delays = timers.mock.calls.map((args) => args[1]);
        expect(delays).toContain(600_000);
        expect(delays).not.toContain(30_000);
        const shown = t.received.find((m) => m.type === dialog.show)!;
        extensionWebSocket.message(t.ws as any, JSON.stringify(dialog.answer(shown.requestId!)));
        await call;
      } finally {
        timers.mockRestore();
      }
      expect((t.sent[0] as RpcResponse).result).toEqual(dialog.result);
    });

    it(`${dialog.method} closes the dialog in every tab once it is answered`, async () => {
      const t = setUp();
      cleanup = t.close;
      const call = t.channel.handleMessage({ type: "request", id: 1, method: dialog.method, params: [...dialog.params] });
      const shown = t.received.find((m) => m.type === dialog.show)!;
      extensionWebSocket.message(t.ws as any, JSON.stringify(dialog.answer(shown.requestId!)));
      await call;
      expect(t.received.at(-1)).toEqual({ type: dialog.dismiss, requestId: shown.requestId });
    });

    it(`${dialog.method} stops waiting and closes the dialog when the asking host is rebuilt`, async () => {
      const t = setUp(7);
      cleanup = t.close;
      const call = t.channel.handleMessage({ type: "request", id: 1, method: dialog.method, params: [...dialog.params] });
      const shown = t.received.find((m) => m.type === dialog.show)!;
      expect(t.registry.count(7)).toBe(1);

      t.registry.endGeneration(7);
      await call;

      const response = t.sent[0] as RpcResponse;
      expect(response.error).toBeUndefined();
      expect(response.result ?? undefined).toBeUndefined();
      expect(t.received.at(-1)).toEqual({ type: dialog.dismiss, requestId: shown.requestId });
      expect(t.registry.count()).toBe(0);
      // A late answer from a tab that had not closed yet finds nobody waiting.
      extensionWebSocket.message(t.ws as any, JSON.stringify(dialog.answer(shown.requestId!)));
      expect(t.sent).toHaveLength(1);
    });
  }

  it("does not show a dialog at all for a host that was already rebuilt", async () => {
    const t = setUp(3);
    cleanup = t.close;
    t.registry.endGeneration(3);
    await t.channel.handleMessage({ type: "request", id: 1, method: "window:showInputBox", params: [{}] });
    expect(t.received.some((m) => m.type === "inputbox:show")).toBe(false);
    expect((t.sent[0] as RpcResponse).result ?? undefined).toBeUndefined();
  });
});
