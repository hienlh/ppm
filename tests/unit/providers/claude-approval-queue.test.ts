import { describe, expect, it, mock } from "bun:test";
import { APPROVAL_WAKE, ApprovalQueue } from "../../../src/providers/claude-approval-queue.ts";

/** Everything the loop sees, with each wake replaced by what it drained. */
async function collect<T>(queue: ApprovalQueue<string>, source: AsyncIterable<T>): Promise<Array<T | string>> {
  const seen: Array<T | string> = [];
  for await (const item of queue.alongside(source)) {
    if (item === APPROVAL_WAKE) seen.push(...[...queue.drain()].map((q) => `queued:${q}`));
    else seen.push(item);
  }
  return seen;
}

/** A source that stays silent after `first` until `release` is called, as the CLI does after asking. */
function silentAfter<T>(first: T, last: T) {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  async function* source() {
    yield first;
    await released;
    yield last;
  }
  return { source: source(), release };
}

describe("ApprovalQueue.alongside", () => {
  it("hands out what is queued while the source says nothing", async () => {
    const queue = new ApprovalQueue<string>();
    const { source, release } = silentAfter("tool_use", "result");
    const seen: unknown[] = [];
    for await (const item of queue.alongside(source)) {
      if (item === APPROVAL_WAKE) {
        seen.push(...queue.drain());
        // Answering is what lets the source go on.
        release();
        continue;
      }
      seen.push(item);
      if (item === "tool_use") setTimeout(() => queue.push("question"), 10);
    }
    expect(seen).toEqual(["tool_use", "question", "result"]);
  });

  it("delivers the item that was on its way when the wake came, once and in order", async () => {
    const queue = new ApprovalQueue<string>();
    async function* source() {
      yield "a";
      await Bun.sleep(30);
      yield "b";
    }
    setTimeout(() => queue.push("q"), 10);
    expect(await collect(queue, source())).toEqual(["a", "queued:q", "b"]);
  });

  it("wakes for something queued while the next item was being asked for", async () => {
    const queue = new ApprovalQueue<string>();
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let calls = 0;
    // The callback runs inside next() itself, before the loop has a wake to call.
    const source: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (calls++ > 0) return { done: true, value: undefined };
          queue.push("question");
          await released;
          return { done: false, value: "result" };
        },
      }),
    };
    const seen: unknown[] = [];
    for await (const item of queue.alongside(source)) {
      if (item === APPROVAL_WAKE) {
        seen.push(...queue.drain());
        release();
      } else {
        seen.push(item);
      }
    }
    expect(seen).toEqual(["question", "result"]);
  });

  it("closes the source on an early exit, and not once it has ended or thrown", async () => {
    const queue = new ApprovalQueue<string>();
    const iterator = (items: string[], error?: Error) => {
      const close = mock(async () => ({ done: true as const, value: undefined }));
      const source: AsyncIterable<string> = {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            if (items.length > 0) return { done: false, value: items.shift()! };
            if (error) throw error;
            return { done: true, value: undefined };
          },
          return: close,
        }),
      };
      return { source, close };
    };

    const early = iterator(["a", "b"]);
    for await (const item of queue.alongside(early.source)) if (item === "a") break;
    expect(early.close).toHaveBeenCalledTimes(1);

    const ended = iterator(["a"]);
    expect(await collect(queue, ended.source)).toEqual(["a"]);
    expect(ended.close).not.toHaveBeenCalled();

    const failed = iterator(["a"], new Error("aborted"));
    await expect(collect(queue, failed.source)).rejects.toThrow("aborted");
    expect(failed.close).not.toHaveBeenCalled();
  });

  it("does not wait for the source to close when left while it is still asked for an item", async () => {
    const queue = new ApprovalQueue<string>();
    let closeCli!: () => void;
    const closed = new Promise<void>((r) => (closeCli = r));
    let cleanedUp = false;
    // Like the SDK's message stream: an async generator, whose return() waits behind a next().
    async function* cli() {
      try {
        yield "tool_use";
        await closed;
      } finally {
        cleanedUp = true;
      }
    }

    let left = false;
    const loop = (async () => {
      for await (const item of queue.alongside(cli())) {
        if (item === "tool_use") setTimeout(() => queue.push("question"), 10);
        if (item === APPROVAL_WAKE) break;
      }
      left = true;
    })();
    await Promise.race([loop, Bun.sleep(500)]);
    expect(left).toBe(true);

    // The provider's own teardown closes the query, which ends the stream it was left reading.
    closeCli();
    await Bun.sleep(0);
    expect(cleanedUp).toBe(true);
  });
});
