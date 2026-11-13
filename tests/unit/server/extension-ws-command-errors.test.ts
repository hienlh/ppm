/**
 * A command a browser dispatched may wait on a prompt or slow work, so it gets the prompts' 35 s
 * rather than the RPC default of 10 s; and when it fails, only the device that clicked hears
 * about it. Before, every connected device got an error toast for one device's click.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { BROWSER_COMMAND_TIMEOUT_MS, extensionWebSocket } from "../../../src/server/ws/extensions.ts";
import { PROMPT_REPLY_WAIT_MS } from "../../../packages/vscode-compat/src/window.ts";
import { extensionService } from "../../../src/services/extension.service.ts";

type Sent = { type: string; level?: string; message?: string };
const service = extensionService as unknown as { rpc: unknown };
const original = service.rpc;
afterEach(() => { service.rpc = original; });

function socket() {
  const sent: Sent[] = [];
  const ws = { data: { type: "extensions" }, send: (data: string) => { sent.push(JSON.parse(data)); } };
  extensionWebSocket.open(ws);
  return { ws, sent, close: () => extensionWebSocket.close(ws) };
}

describe("a browser-dispatched command", () => {
  it("waits as long as a prompt may take", async () => {
    expect(BROWSER_COMMAND_TIMEOUT_MS).toBeGreaterThanOrEqual(PROMPT_REPLY_WAIT_MS);
    const calls: Array<{ method: string; timeoutMs: number; params: unknown[] }> = [];
    service.rpc = {
      sendRequestWithTimeout: async (method: string, timeoutMs: number, params: unknown[]) => {
        calls.push({ method, timeoutMs, params });
        return { ok: true };
      },
    };
    const clicker = socket();
    await extensionWebSocket.message(clicker.ws, JSON.stringify({ type: "command:execute", command: "midday.snooze", args: ["chat:1"] }));
    await extensionWebSocket.message(clicker.ws, JSON.stringify({ type: "tree:click", viewId: "v", itemId: "i", command: "midday.open" }));
    clicker.close();
    expect(calls).toEqual([
      { method: "ext:command:execute", timeoutMs: BROWSER_COMMAND_TIMEOUT_MS, params: ["midday.snooze", "chat:1"] },
      { method: "ext:command:execute", timeoutMs: BROWSER_COMMAND_TIMEOUT_MS, params: ["midday.open"] },
    ]);
  });

  it("reports a failure only to the device that clicked", async () => {
    service.rpc = {
      sendRequestWithTimeout: async () => { throw new Error("RPC timeout: ext:command:execute (35000ms)"); },
    };
    const clicker = socket();
    const bystander = socket();
    await extensionWebSocket.message(clicker.ws, JSON.stringify({ type: "command:execute", command: "midday.refresh" }));
    clicker.close();
    bystander.close();
    expect(clicker.sent).toHaveLength(1);
    expect(clicker.sent[0]).toMatchObject({ type: "notification", level: "error" });
    expect(clicker.sent[0]!.message).toContain("RPC timeout");
    expect(bystander.sent).toEqual([]);
  });

  it("tells only the clicker when the host is not ready, or the handler answered a failure", async () => {
    const clicker = socket();
    const bystander = socket();
    service.rpc = null;
    await extensionWebSocket.message(clicker.ws, JSON.stringify({ type: "command:execute", command: "a.b" }));
    service.rpc = { sendRequestWithTimeout: async () => ({ ok: false, error: "boom" }) };
    await extensionWebSocket.message(clicker.ws, JSON.stringify({ type: "command:execute", command: "a.b" }));
    clicker.close();
    bystander.close();
    expect(clicker.sent.map((m) => m.message)).toEqual([
      "Extension host not ready. Try reloading the page.",
      "Extension command failed: boom",
    ]);
    expect(bystander.sent).toEqual([]);
  });
});
