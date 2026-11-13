import { describe, it, expect } from "bun:test";
import { CHAT_SEND_RPC_TIMEOUT_MS, createPpmChat } from "../../../packages/vscode-compat/src/ppm/ppm-chat.ts";
import { createPpmNamespace } from "../../../packages/vscode-compat/src/ppm/index.ts";
import type { RpcClient } from "../../../packages/vscode-compat/src/types.ts";

function mockRpc(answers: Record<string, (params: unknown[]) => unknown> = {}) {
  const requests: { method: string; params: unknown[]; timeoutMs?: number }[] = [];
  const rpc: RpcClient = {
    async request<T>(method: string, ...params: unknown[]): Promise<T> {
      requests.push({ method, params });
      return (answers[method]?.(params) ?? undefined) as T;
    },
    async requestWithTimeout<T>(method: string, timeoutMs: number, ...params: unknown[]): Promise<T> {
      requests.push({ method, params, timeoutMs });
      return (answers[method]?.(params) ?? undefined) as T;
    },
    notify() {},
  };
  return { rpc, requests };
}

describe("ppm.chat", () => {
  it("is the chat area of the ppm namespace", () => {
    const { rpc } = mockRpc();
    expect(typeof createPpmNamespace(rpc, "probe").chat.send).toBe("function");
  });

  it("sends each call as one RPC carrying the session id and the extension's own id where needed", async () => {
    const { rpc, requests } = mockRpc({
      "chat:listProjects": () => [{ name: "p", path: "/p" }],
      "chat:createSession": () => ({ sessionId: "s1", providerId: "claude", projectName: "p", title: "T" }),
      "chat:send": () => ({ sessionId: "s1", queued: false }),
      "chat:lastAssistantText": () => "answer",
      "chat:openTab": () => ({ opened: true }),
    });
    const chat = createPpmChat(rpc, "probe-ext");

    expect(await chat.listProjects()).toEqual([{ name: "p", path: "/p" }]);
    expect((await chat.createSession({ projectName: "p", providerId: "claude", title: "T" })).sessionId).toBe("s1");
    expect(await chat.send("s1", { content: "go", timeoutMs: 5_000, model: "claude-haiku-4-5" })).toEqual({ sessionId: "s1", queued: false });
    await chat.cancel("s1");
    expect(await chat.lastAssistantText("s1")).toBe("answer");
    expect(await chat.openTab("s1")).toEqual({ opened: true });

    expect(requests.map((r) => r.method)).toEqual([
      "chat:listProjects", "chat:createSession", "chat:send", "chat:cancel", "chat:lastAssistantText", "chat:openTab",
    ]);
    // Creating, sending and cancelling carry the extension's id: a session is only its creator's to drive.
    expect(requests[1]!.params).toEqual([{ projectName: "p", providerId: "claude", title: "T", extensionId: "probe-ext" }]);
    expect(requests[2]!.params).toEqual([{ content: "go", timeoutMs: 5_000, model: "claude-haiku-4-5", sessionId: "s1", extensionId: "probe-ext" }]);
    // A send can wait out another door's consumer start, well past the 10 s every other RPC gets.
    expect(requests[2]!.timeoutMs).toBe(CHAT_SEND_RPC_TIMEOUT_MS);
    expect(CHAT_SEND_RPC_TIMEOUT_MS).toBeGreaterThanOrEqual(130_000);
    expect(requests[3]!.params).toEqual([{ sessionId: "s1", extensionId: "probe-ext" }]);
    // Reading a chat names the extension too: it may read only the chats it created.
    expect(requests[4]!.params).toEqual([{ sessionId: "s1", extensionId: "probe-ext" }]);
    expect(requests[5]!.params).toEqual([{ sessionId: "s1", extensionId: "probe-ext" }]);
  });

  it("waitForIdle polls state until no turn runs and answers with that state", async () => {
    let polls = 0;
    const { rpc, requests } = mockRpc({
      "chat:state": () => (++polls < 3 ? { running: true, phase: "thinking" } : { running: false, phase: "idle" }),
    });
    const chat = createPpmChat(rpc, "probe-ext");
    const state = await chat.waitForIdle("s1", { pollMs: 1 });
    expect(state).toEqual({ running: false, phase: "idle" });
    expect(requests.filter((r) => r.method === "chat:state")).toHaveLength(3);
    expect(requests[0]!.params).toEqual([{ sessionId: "s1", extensionId: "probe-ext" }]);
  });

  it("waitForIdle gives up after timeoutMs while the turn keeps running", async () => {
    const { rpc } = mockRpc({ "chat:state": () => ({ running: true, phase: "streaming" }) });
    const chat = createPpmChat(rpc, "probe-ext");
    await expect(chat.waitForIdle("s1", { pollMs: 1, timeoutMs: 20 })).rejects.toThrow("still running");
  });
});
