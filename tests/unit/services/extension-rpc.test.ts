import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { RpcChannel } from "../../../src/services/extension-rpc.ts";
import type { RpcMessage, RpcRequest, RpcResponse, RpcEvent } from "../../../src/types/extension.ts";

describe("RpcChannel", () => {
  let sentMessages: RpcMessage[] = [];
  let channel: RpcChannel;
  let pendingPromises: Promise<unknown>[] = [];

  beforeEach(() => {
    sentMessages = [];
    pendingPromises = [];
    const postFn = (msg: RpcMessage) => {
      sentMessages.push(msg);
    };
    channel = new RpcChannel(postFn);
  });

  afterEach(async () => {
    // Dispose first to clear all pending timers, then drain rejected promises
    channel.dispose();
    await Promise.allSettled(pendingPromises);
    pendingPromises = [];
  });

  describe("sendRequest", () => {
    it("sends request with auto-incrementing ID", async () => {
      const promise = channel.sendRequest("test-method", "arg1", 42);
      expect(sentMessages.length).toBe(1);
      const msg = sentMessages[0] as RpcRequest;
      expect(msg.type).toBe("request");
      expect(msg.id).toBe(1);
      expect(msg.method).toBe("test-method");
      expect(msg.params).toEqual(["arg1", 42]);

      // Simulate response
      const response: RpcResponse = { type: "response", id: 1, result: "success" };
      await channel.handleMessage(response);
      const result = await promise;
      expect(result).toBe("success");
    });

    it("increments request ID for multiple calls", async () => {
      const p1 = channel.sendRequest("method1");
      const p2 = channel.sendRequest("method2");
      const p3 = channel.sendRequest("method3");

      expect(sentMessages[0].type).toBe("request");
      expect((sentMessages[0] as RpcRequest).id).toBe(1);
      expect((sentMessages[1] as RpcRequest).id).toBe(2);
      expect((sentMessages[2] as RpcRequest).id).toBe(3);

      // Resolve in reverse order to test ID matching
      await channel.handleMessage({ type: "response", id: 3, result: "r3" });
      await channel.handleMessage({ type: "response", id: 1, result: "r1" });
      await channel.handleMessage({ type: "response", id: 2, result: "r2" });

      expect(await p1).toBe("r1");
      expect(await p2).toBe("r2");
      expect(await p3).toBe("r3");
    });

    it("handles response with error", async () => {
      const promise = channel.sendRequest("method");
      const response: RpcResponse = { type: "response", id: 1, error: "Failed" };
      await channel.handleMessage(response);

      try {
        await promise;
        expect.unreachable("Should throw");
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
        expect((e as Error).message).toBe("Failed");
      }
    });

    it("timeout rejects after 10 seconds", async () => {
      const promise = channel.sendRequest("method");
      pendingPromises.push(promise.catch(() => {}));
      // Don't send response, let timeout fire

      try {
        await promise;
        expect.unreachable("Should timeout");
      } catch (e) {
        expect((e as Error).message).toContain("RPC timeout");
        expect((e as Error).message).toContain("method");
      }
    }, { timeout: 15000 });

    it("clears pending request on timeout", async () => {
      const promise = channel.sendRequest("method");
      pendingPromises.push(promise.catch(() => {}));
      // Let it timeout
      try {
        await promise;
      } catch {
        // expected
      }
      // Verify cleanup by checking we can send another request with incremented ID
      const promise2 = channel.sendRequest("method2");
      pendingPromises.push(promise2.catch(() => {}));
      const msg = sentMessages[1] as RpcRequest;
      expect(msg.id).toBe(2); // Should increment, not reuse ID 1
    }, { timeout: 20000 });
  });

  describe("sendEvent", () => {
    it("sends event without response", () => {
      channel.sendEvent("test-event", { data: "value" });
      expect(sentMessages.length).toBe(1);
      const msg = sentMessages[0] as RpcEvent;
      expect(msg.type).toBe("event");
      expect(msg.event).toBe("test-event");
      expect(msg.data).toEqual({ data: "value" });
    });

    it("sends multiple events", () => {
      channel.sendEvent("event1", 1);
      channel.sendEvent("event2", { x: 2 });
      channel.sendEvent("event3", null);

      expect(sentMessages.length).toBe(3);
      expect((sentMessages[0] as RpcEvent).event).toBe("event1");
      expect((sentMessages[1] as RpcEvent).event).toBe("event2");
      expect((sentMessages[2] as RpcEvent).event).toBe("event3");
    });
  });

  describe("onRequest + handleMessage", () => {
    it("handles incoming request and sends response", async () => {
      channel.onRequest("add", (params) => {
        const [a, b] = params as [number, number];
        return a + b;
      });

      const request: RpcRequest = { type: "request", id: 99, method: "add", params: [5, 3] };
      await channel.handleMessage(request);

      expect(sentMessages.length).toBe(1);
      const response = sentMessages[0] as RpcResponse;
      expect(response.type).toBe("response");
      expect(response.id).toBe(99);
      expect(response.result).toBe(8);
      expect(response.error).toBeUndefined();
    });

    it("handles async request handler", async () => {
      channel.onRequest("async-method", async (params) => {
        // Simulate async work
        const [val] = params as [string];
        return val.toUpperCase();
      });

      const request: RpcRequest = { type: "request", id: 1, method: "async-method", params: ["hello"] };
      await channel.handleMessage(request);

      const response = sentMessages[0] as RpcResponse;
      expect(response.result).toBe("HELLO");
    });

    it("sends error response if handler throws", async () => {
      channel.onRequest("error-method", () => {
        throw new Error("Handler failed");
      });

      const request: RpcRequest = { type: "request", id: 1, method: "error-method", params: [] };
      await channel.handleMessage(request);

      const response = sentMessages[0] as RpcResponse;
      expect(response.error).toBe("Handler failed");
      expect(response.result).toBeUndefined();
    });

    it("returns error if no handler registered", async () => {
      const request: RpcRequest = { type: "request", id: 1, method: "unknown-method", params: [] };
      await channel.handleMessage(request);

      const response = sentMessages[0] as RpcResponse;
      expect(response.error).toContain("No handler for method");
      expect(response.error).toContain("unknown-method");
    });

    it("handles non-Error thrown exceptions", async () => {
      channel.onRequest("throw-string", () => {
        throw "not an error";
      });

      const request: RpcRequest = { type: "request", id: 1, method: "throw-string", params: [] };
      await channel.handleMessage(request);

      const response = sentMessages[0] as RpcResponse;
      expect(response.error).toContain("not an error");
    });
  });

  describe("onEvent + handleMessage", () => {
    it("calls event handler on matching event", async () => {
      let received: unknown;
      channel.onEvent("my-event", (data) => {
        received = data;
      });

      const event: RpcEvent = { type: "event", event: "my-event", data: { foo: "bar" } };
      await channel.handleMessage(event);

      expect(received).toEqual({ foo: "bar" });
    });

    it("supports multiple handlers for same event", async () => {
      const results: unknown[] = [];
      channel.onEvent("event", (data) => results.push(data));
      channel.onEvent("event", (data) => results.push(`[${data}]`));

      const event: RpcEvent = { type: "event", event: "event", data: "test" };
      await channel.handleMessage(event);

      expect(results.length).toBe(2);
      expect(results[0]).toBe("test");
      expect(results[1]).toBe("[test]");
    });

    it("ignores unregistered events silently", async () => {
      const event: RpcEvent = { type: "event", event: "unknown", data: "test" };
      // Should not throw
      await channel.handleMessage(event);
    });

    it("catches exceptions in event handlers", async () => {
      const errors: Error[] = [];
      const oldLog = console.error;
      console.error = (msg: string, err: unknown) => {
        if (err instanceof Error) errors.push(err);
      };

      channel.onEvent("bad-event", () => {
        throw new Error("Handler error");
      });

      const event: RpcEvent = { type: "event", event: "bad-event", data: null };
      await channel.handleMessage(event);

      console.error = oldLog;
      // Handler error should be logged but not throw
    });
  });

  describe("dispose", () => {
    it("clears all pending requests with error", async () => {
      const p1 = channel.sendRequest("method1");
      const p2 = channel.sendRequest("method2");
      pendingPromises.push(p1.catch(() => {}));
      pendingPromises.push(p2.catch(() => {}));

      // Dispose locally instead of in afterEach
      const disposeChannel = channel;
      channel = new RpcChannel((msg) => sentMessages.push(msg));

      disposeChannel.dispose();

      try {
        await p1;
        expect.unreachable("Should throw");
      } catch (e) {
        expect((e as Error).message).toBe("RPC channel disposed");
      }

      try {
        await p2;
        expect.unreachable("Should throw");
      } catch (e) {
        expect((e as Error).message).toBe("RPC channel disposed");
      }
    });
  });
});
