import { describe, expect, test } from "bun:test";
import {
  applyQueueLifecycle, drainForDispatch, enqueueMessage, mergeablePrefix, mergeEntries, queueState, sendQueuedNow, takeBackQueued,
  type QueueDeps, type QueueHolder,
} from "../../../src/server/ws/chat-message-queue.ts";
import { decodeMessageBlocks, encodeMessageBlocks } from "../../../src/shared/chat-message-blocks.ts";
import type { ReplyReference } from "../../../src/shared/chat-reply.ts";
import type { AIProvider } from "../../../src/types/chat.ts";

function harness(opts: { native: boolean; pushOk?: boolean; cancelOk?: boolean }) {
  const events: any[] = [];
  const pushes: Array<{ content: string; opts: any }> = [];
  const calls: string[] = [];
  const provider = {
    ...(opts.native ? {
      cancelQueuedMessage: async (_s: string, id: string) => { calls.push(`cancel:${id}`); return opts.cancelOk ?? true; },
      sendQueuedNow: async () => { calls.push("sendNow"); },
    } : {}),
  } as unknown as AIProvider;
  const deps: QueueDeps = {
    sessionId: "s1",
    provider,
    broadcast: (e) => events.push(e),
    push: async (content, o) => { pushes.push({ content, opts: o }); return opts.pushOk ?? true; },
  };
  const holder: QueueHolder = {};
  return { events, pushes, calls, deps, holder };
}

describe("chat message queue", () => {
  test("a native provider gets the message at once, tagged with the entry id, and every device sees the queue", async () => {
    const h = harness({ native: true });
    const entry = await enqueueMessage(h.holder, { content: "hi", clientMessageId: "c1" }, h.deps);
    if (entry === "stream_closed") throw new Error("unexpected");
    expect(entry.native).toBe(true);
    expect(h.pushes).toEqual([{ content: "hi", opts: { queueId: entry.id, images: undefined, imagePaths: undefined, clientMessageId: "c1" } }]);
    expect(h.events.at(-1)).toEqual({ type: "queue_state", queue: queueState(h.holder) });
    expect(queueState(h.holder)).toEqual([{ id: entry.id, content: "hi", imageCount: 0, clientMessageId: "c1", queuedAt: entry.queuedAt }]);
  });

  test("another provider's message is held, not pushed", async () => {
    const h = harness({ native: false });
    const entry = await enqueueMessage(h.holder, { content: "hi" }, h.deps);
    expect(entry !== "stream_closed" && entry.native).toBe(false);
    expect(h.pushes).toEqual([]);
    expect(h.holder.queue).toHaveLength(1);
  });

  test("a push no stream took leaves nothing queued and reports stream_closed", async () => {
    const h = harness({ native: true, pushOk: false });
    expect(await enqueueMessage(h.holder, { content: "hi" }, h.deps)).toBe("stream_closed");
    expect(h.holder.queue).toEqual([]);
  });

  test("started removes the entry and hands it back; cancelled removes it silently; unknown ids are ignored", async () => {
    const h = harness({ native: true });
    const a = await enqueueMessage(h.holder, { content: "a" }, h.deps);
    const b = await enqueueMessage(h.holder, { content: "b" }, h.deps);
    if (a === "stream_closed" || b === "stream_closed") throw new Error("unexpected");
    expect(applyQueueLifecycle(h.holder, "first-prompt", "started", h.deps)).toBeUndefined();
    expect(applyQueueLifecycle(h.holder, a.id, "queued", h.deps)).toBeUndefined();
    expect(h.holder.queue).toHaveLength(2);
    expect(applyQueueLifecycle(h.holder, a.id, "started", h.deps)?.content).toBe("a");
    expect(applyQueueLifecycle(h.holder, b.id, "cancelled", h.deps)).toBeUndefined();
    expect(h.holder.queue).toEqual([]);
    expect(h.events.at(-1)).toEqual({ type: "queue_state", queue: [] });
  });

  test("a started report that beats the push back leaves nothing listed", async () => {
    const h = harness({ native: true });
    h.deps.push = async (_c, o) => { applyQueueLifecycle(h.holder, o.queueId!, "started", h.deps); return true; };
    await enqueueMessage(h.holder, { content: "a" }, h.deps);
    expect(h.holder.queue).toEqual([]);
    expect(h.events.at(-1)).toEqual({ type: "queue_state", queue: [] });
  });

  test("take back cancels a native entry with the provider; refused once the AI is reading it", async () => {
    const h = harness({ native: true });
    const a = await enqueueMessage(h.holder, { content: "a" }, h.deps);
    if (a === "stream_closed") throw new Error("unexpected");
    expect((await takeBackQueued(h.holder, a.id, h.deps))?.content).toBe("a");
    expect(h.calls).toEqual([`cancel:${a.id}`]);
    expect(h.holder.queue).toEqual([]);

    const refused = harness({ native: true, cancelOk: false });
    const b = await enqueueMessage(refused.holder, { content: "b" }, refused.deps);
    if (b === "stream_closed") throw new Error("unexpected");
    expect(await takeBackQueued(refused.holder, b.id, refused.deps)).toBeUndefined();
    expect(refused.holder.queue).toHaveLength(1);
  });

  test("send now asks a native provider; held entries go out as one message and are returned", async () => {
    const n = harness({ native: true });
    await enqueueMessage(n.holder, { content: "a" }, n.deps);
    expect(await sendQueuedNow(n.holder, n.deps)).toEqual([]);
    expect(n.calls).toEqual(["sendNow"]);

    const h = harness({ native: false });
    await enqueueMessage(h.holder, { content: "one", images: [{ data: "x", mediaType: "image/png" }] }, h.deps);
    await enqueueMessage(h.holder, { content: "two" }, h.deps);
    const sent = await sendQueuedNow(h.holder, h.deps);
    expect(sent.map((e) => e.content)).toEqual(["one", "two"]);
    expect(h.pushes).toEqual([{ content: "one\n\ntwo", opts: { images: [{ data: "x", mediaType: "image/png" }], imagePaths: undefined, clientMessageId: undefined } }]);
    expect(h.holder.queue).toEqual([]);
  });

  test("drain takes held entries at a turn's end, and everything once the stream is gone", async () => {
    const h = harness({ native: true });
    await enqueueMessage(h.holder, { content: "native" }, h.deps);
    h.holder.queue!.push({ id: "held", content: "held", imageCount: 0, queuedAt: "", native: false });
    expect(drainForDispatch(h.holder, h.deps).map((e) => e.id)).toEqual(["held"]);
    expect(h.holder.queue!.map((e) => e.content)).toEqual(["native"]);
    expect(drainForDispatch(h.holder, h.deps, true).map((e) => e.content)).toEqual(["native"]);
    expect(h.holder.queue).toEqual([]);
  });

  test("merged messages keep their reply as a block, and a second reply waits for the next message", async () => {
    const reply = (quote: string): ReplyReference => ({ version: 1, sessionId: "s1", providerId: "claude", messageId: `m-${quote}`, role: "assistant", timestamp: "2026-11-10T00:00:00Z", quote, truncated: false });
    const h = harness({ native: false });
    await enqueueMessage(h.holder, { content: "plain" }, h.deps);
    await enqueueMessage(h.holder, { content: encodeMessageBlocks("answer one", { replyTo: reply("one") }) }, h.deps);
    await enqueueMessage(h.holder, { content: encodeMessageBlocks("answer two", { replyTo: reply("two") }) }, h.deps);
    expect(mergeablePrefix(h.holder.queue!)).toBe(2);

    const first = drainForDispatch(h.holder, h.deps);
    expect(decodeMessageBlocks(mergeEntries(first).content)).toMatchObject({ content: "plain\n\nanswer one", replyTo: reply("one") });
    // The second reply goes out at the next turn's end.
    expect(h.holder.queue!.map((e) => decodeMessageBlocks(e.content).content)).toEqual(["answer two"]);
    expect(decodeMessageBlocks(mergeEntries(drainForDispatch(h.holder, h.deps)).content).replyTo).toEqual(reply("two"));
  });

  test("merge keeps one message's client id only", () => {
    const one = mergeEntries([{ id: "a", content: "a", imageCount: 0, queuedAt: "", native: false, clientMessageId: "c" }]);
    expect(one).toEqual({ content: "a", clientMessageId: "c" });
    const two = mergeEntries([
      { id: "a", content: "a", imageCount: 0, queuedAt: "", native: false, clientMessageId: "c" },
      { id: "b", content: "b", imageCount: 0, queuedAt: "", native: false, imagePaths: ["/p.png"] },
    ]);
    expect(two).toEqual({ content: "a\n\nb", imagePaths: ["/p.png"] });
  });
});
