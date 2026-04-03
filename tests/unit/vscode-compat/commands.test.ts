import { describe, it, expect, beforeEach } from "bun:test";
import { CommandService } from "../../../packages/vscode-compat/src/commands.ts";
import type { RpcClient } from "../../../packages/vscode-compat/src/types.ts";

function createMockRpc(): RpcClient & { requests: { method: string; params: unknown[] }[]; notifications: { event: string; data: unknown }[] } {
  const mock = {
    requests: [] as { method: string; params: unknown[] }[],
    notifications: [] as { event: string; data: unknown }[],
    async request<T = unknown>(method: string, ...params: unknown[]): Promise<T> {
      mock.requests.push({ method, params });
      return undefined as T;
    },
    notify(event: string, data: unknown): void {
      mock.notifications.push({ event, data });
    },
  };
  return mock;
}

describe("CommandService", () => {
  let rpc: ReturnType<typeof createMockRpc>;
  let commands: CommandService;

  beforeEach(() => {
    rpc = createMockRpc();
    commands = new CommandService(rpc, "test-ext");
  });

  describe("registerCommand", () => {
    it("registers and executes a local command", async () => {
      let called = false;
      commands.registerCommand("test.hello", () => { called = true; return "ok"; });

      const result = await commands.executeCommand("test.hello");

      expect(called).toBe(true);
      expect(result).toBe("ok");
    });

    it("notifies main process about registration", () => {
      commands.registerCommand("test.cmd", () => {});

      expect(rpc.notifications.length).toBe(1);
      expect(rpc.notifications[0]!.event).toBe("commands:register");
      expect(rpc.notifications[0]!.data).toEqual({ extId: "test-ext", command: "test.cmd" });
    });

    it("disposal removes the command and notifies", () => {
      const disposable = commands.registerCommand("test.cmd", () => "value");
      disposable.dispose();

      // After disposal, command should go to RPC (not local)
      commands.executeCommand("test.cmd");
      expect(rpc.requests.some((r) => r.method === "commands:execute")).toBe(true);
    });

    it("passes arguments to command handler", async () => {
      let receivedArgs: unknown[] = [];
      commands.registerCommand("test.args", (...args) => { receivedArgs = args; });

      await commands.executeCommand("test.args", 1, "two", true);

      expect(receivedArgs).toEqual([1, "two", true]);
    });
  });

  describe("executeCommand", () => {
    it("delegates to RPC for unknown commands", async () => {
      await commands.executeCommand("unknown.cmd", "arg1");

      expect(rpc.requests.length).toBe(1);
      expect(rpc.requests[0]!.method).toBe("commands:execute");
      expect(rpc.requests[0]!.params).toEqual(["unknown.cmd", "arg1"]);
    });

    it("prefers local handler over RPC", async () => {
      commands.registerCommand("test.local", () => "local-result");

      const result = await commands.executeCommand("test.local");

      expect(result).toBe("local-result");
      // Should NOT have sent RPC request for this command
      expect(rpc.requests.filter((r) => r.method === "commands:execute").length).toBe(0);
    });
  });

  describe("getCommands", () => {
    it("merges local and remote commands", async () => {
      commands.registerCommand("test.local1", () => {});
      commands.registerCommand("test.local2", () => {});
      // Mock remote response
      rpc.request = async () => ["remote.cmd1", "remote.cmd2"] as any;

      const result = await commands.getCommands();

      expect(result).toContain("test.local1");
      expect(result).toContain("test.local2");
      expect(result).toContain("remote.cmd1");
    });

    it("deduplicates commands", async () => {
      commands.registerCommand("shared.cmd", () => {});
      rpc.request = async () => ["shared.cmd", "remote.cmd"] as any;

      const result = await commands.getCommands();
      const sharedCount = result.filter((c) => c === "shared.cmd").length;

      expect(sharedCount).toBe(1);
    });
  });
});
