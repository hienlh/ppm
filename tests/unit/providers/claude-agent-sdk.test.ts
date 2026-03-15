import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import type { ChatEvent } from "../../../src/types/chat.ts";

/**
 * Helper: create an async iterable from an array of items with optional delay.
 * Supports being "closed" mid-iteration (simulates SDK query.close()).
 */
function createMockQueryIterator(
  items: Array<{ type: string; message?: unknown }>,
  delayMs = 10,
) {
  let closed = false;
  let closeResolve: (() => void) | undefined;
  const closePromise = new Promise<void>((r) => (closeResolve = r));

  const iterator: AsyncIterableIterator<any> & { close: () => void } = {
    close() {
      closed = true;
      closeResolve?.();
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (closed) return { done: true, value: undefined };

      if (items.length === 0) return { done: true, value: undefined };

      // Small delay to simulate streaming
      await new Promise((r) => setTimeout(r, delayMs));

      if (closed) return { done: true, value: undefined };

      const item = items.shift()!;
      return { done: false, value: item };
    },
  };

  return iterator;
}

// Mock the SDK module
let mockQueryFn: ReturnType<typeof mock>;

mock.module("@anthropic-ai/claude-agent-sdk", () => {
  mockQueryFn = mock((...args: any[]) => {
    // Default: return empty iterator. Tests override via mockQueryFn.mockImplementation()
    return createMockQueryIterator([]);
  });
  return {
    query: (...args: any[]) => mockQueryFn(...args),
    listSessions: mock(() => Promise.resolve([])),
    getSessionMessages: mock(() => Promise.resolve([])),
  };
});

// Import AFTER mocking
const { ClaudeAgentSdkProvider } = await import(
  "../../../src/providers/claude-agent-sdk.ts"
);

describe("ClaudeAgentSdkProvider", () => {
  let provider: InstanceType<typeof ClaudeAgentSdkProvider>;

  beforeEach(() => {
    provider = new ClaudeAgentSdkProvider();
    mockQueryFn.mockReset();
  });

  describe("sendMessage", () => {
    it("yields text events from partial messages", async () => {
      const iter = createMockQueryIterator([
        {
          type: "partial",
          message: { content: [{ type: "text", text: "Hello" }] },
        },
        {
          type: "partial",
          message: { content: [{ type: "text", text: "Hello world" }] },
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Hello world" }] },
        },
        { type: "result" },
      ]);
      mockQueryFn.mockReturnValue(iter);

      const session = await provider.createSession({});
      const events: ChatEvent[] = [];
      for await (const event of provider.sendMessage(session.id, "hi")) {
        events.push(event);
      }

      const textEvents = events.filter((e) => e.type === "text");
      expect(textEvents.length).toBeGreaterThan(0);

      const fullText = textEvents.map((e) => (e as any).content).join("");
      expect(fullText).toContain("Hello");

      const done = events.find((e) => e.type === "done");
      expect(done).toBeTruthy();
    });

    it("yields tool_use events from assistant messages", async () => {
      const iter = createMockQueryIterator([
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", name: "Read", input: { path: "test.ts" } },
            ],
          },
        },
        { type: "result" },
      ]);
      mockQueryFn.mockReturnValue(iter);

      const session = await provider.createSession({});
      const events: ChatEvent[] = [];
      for await (const event of provider.sendMessage(session.id, "read file")) {
        events.push(event);
      }

      const toolUse = events.find((e) => e.type === "tool_use");
      expect(toolUse).toBeTruthy();
      expect((toolUse as any).tool).toBe("Read");
    });

    it("always yields done event even on empty response", async () => {
      const iter = createMockQueryIterator([{ type: "result" }]);
      mockQueryFn.mockReturnValue(iter);

      const session = await provider.createSession({});
      const events: ChatEvent[] = [];
      for await (const event of provider.sendMessage(session.id, "hi")) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("done");
    });

    it("yields done event after SDK error (non-abort)", async () => {
      mockQueryFn.mockImplementation(() => {
        const iter = createMockQueryIterator([], 0);
        // Override next to throw
        iter.next = async () => {
          throw new Error("SDK connection failed");
        };
        return iter;
      });

      const session = await provider.createSession({});
      const events: ChatEvent[] = [];
      for await (const event of provider.sendMessage(session.id, "hi")) {
        events.push(event);
      }

      const error = events.find((e) => e.type === "error");
      expect(error).toBeTruthy();
      expect((error as any).message).toContain("SDK connection failed");

      const done = events.find((e) => e.type === "done");
      expect(done).toBeTruthy();
    });

    it("uses sessionId for first message and resume for subsequent", async () => {
      // First call
      mockQueryFn.mockReturnValue(
        createMockQueryIterator([{ type: "result" }]),
      );

      const session = await provider.createSession({});
      const events1: ChatEvent[] = [];
      for await (const event of provider.sendMessage(session.id, "first")) {
        events1.push(event);
      }

      expect(mockQueryFn).toHaveBeenCalledTimes(1);
      const firstCall = mockQueryFn.mock.calls[0]![0];
      expect(firstCall.options.sessionId).toBe(session.id);
      expect(firstCall.options.resume).toBeUndefined();

      // Second call
      mockQueryFn.mockReturnValue(
        createMockQueryIterator([{ type: "result" }]),
      );

      const events2: ChatEvent[] = [];
      for await (const event of provider.sendMessage(session.id, "second")) {
        events2.push(event);
      }

      const secondCall = mockQueryFn.mock.calls[1]![0];
      expect(secondCall.options.sessionId).toBeUndefined();
      expect(secondCall.options.resume).toBe(session.id);
    });
  });

  describe("abortQuery (cancel)", () => {
    it("calls close() on active SDK query", async () => {
      const iter = createMockQueryIterator(
        [
          {
            type: "partial",
            message: { content: [{ type: "text", text: "Working..." }] },
          },
          // Many more items that won't be reached after close
          {
            type: "partial",
            message: {
              content: [{ type: "text", text: "Working... still going" }],
            },
          },
          {
            type: "partial",
            message: {
              content: [
                { type: "text", text: "Working... still going... more" },
              ],
            },
          },
          { type: "result" },
        ],
        100, // slow enough to cancel mid-stream
      );

      const closeSpy = spyOn(iter, "close");
      mockQueryFn.mockReturnValue(iter);

      const session = await provider.createSession({});

      // Start streaming in background
      const events: ChatEvent[] = [];
      const streamPromise = (async () => {
        for await (const event of provider.sendMessage(session.id, "hello")) {
          events.push(event);
        }
      })();

      // Wait for first event
      await new Promise((r) => setTimeout(r, 50));

      // Cancel
      provider.abortQuery(session.id);

      expect(closeSpy).toHaveBeenCalledTimes(1);

      // Wait for stream to finish
      await streamPromise;

      // Should have done event (always emitted)
      const done = events.find((e) => e.type === "done");
      expect(done).toBeTruthy();
    });

    it("does not yield error event on abort", async () => {
      // Simulate SDK throwing abort error when query is closed
      let rejectNext: ((err: Error) => void) | undefined;

      mockQueryFn.mockImplementation(() => {
        let callCount = 0;
        const q = {
          close() {
            rejectNext?.(new Error("aborted"));
          },
          [Symbol.asyncIterator]() {
            return this;
          },
          async next(): Promise<{ done: boolean; value: any }> {
            callCount++;
            if (callCount === 1) {
              return {
                done: false,
                value: {
                  type: "partial",
                  message: { content: [{ type: "text", text: "Hi" }] },
                },
              };
            }
            // Second call: wait to be aborted
            return new Promise((resolve, reject) => {
              rejectNext = reject;
              // Also resolve after timeout as fallback
              setTimeout(
                () => resolve({ done: true, value: undefined }),
                5000,
              );
            });
          },
        };
        return q;
      });

      const session = await provider.createSession({});
      const events: ChatEvent[] = [];
      const streamPromise = (async () => {
        for await (const event of provider.sendMessage(session.id, "test")) {
          events.push(event);
        }
      })();

      // Wait for first event
      await new Promise((r) => setTimeout(r, 50));

      // Cancel — should trigger abort error
      provider.abortQuery(session.id);

      await streamPromise;

      // Should NOT have an error event (abort is intentional)
      const errors = events.filter((e) => e.type === "error");
      expect(errors).toHaveLength(0);

      // Should still have done event
      const done = events.find((e) => e.type === "done");
      expect(done).toBeTruthy();
    });

    it("abortQuery is no-op when no active query", () => {
      // Should not throw
      expect(() => provider.abortQuery("nonexistent-session")).not.toThrow();
    });

    it("cleans up activeQueries after stream ends", async () => {
      const iter = createMockQueryIterator([{ type: "result" }]);
      mockQueryFn.mockReturnValue(iter);

      const session = await provider.createSession({});
      for await (const _ of provider.sendMessage(session.id, "hi")) {
        // consume
      }

      // abortQuery should be no-op now (query already cleaned up)
      expect(() => provider.abortQuery(session.id)).not.toThrow();
    });
  });
});
