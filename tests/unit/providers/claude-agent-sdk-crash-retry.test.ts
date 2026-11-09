/**
 * What a crash retry is allowed to re-send.
 *
 * A Claude subprocess that exits is retried once. The retry used to re-push a user message into
 * the rebuilt subprocess whatever the session was doing, and with the session entry already
 * deleted it reached past every follow-up to the message that opened the stream — so an
 * instruction given hours earlier arrived as a genuine new turn and ran a second time. Observed
 * on 30/10/2026: two live sessions in different projects replayed their opening message 0.686 s
 * apart, after `exited with code 9` hit both.
 *
 * The rule these tests pin: a retry may resume a turn that was in flight, and must send nothing
 * at all when no turn was waiting for a reply.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { ChatEvent } from "../../../src/types/chat.ts";

let mockQueryFn: ReturnType<typeof mock>;

mock.module("@anthropic-ai/claude-agent-sdk", () => {
  mockQueryFn = mock(() => neverEnds());
  return {
    query: (...args: any[]) => mockQueryFn(...args),
    listSessions: mock(() => Promise.resolve([])),
    getSessionInfo: mock(() => Promise.resolve(undefined)),
    getSessionMessages: mock(() => Promise.resolve([])),
    forkSession: mock(() => Promise.resolve({ sessionId: "mock-fork-id" })),
    renameSession: mock(() => Promise.resolve()),
  };
});

const { ClaudeAgentSdkProvider } = await import("../../../src/providers/claude-agent-sdk.ts");

/** An SDK stream that never produces anything — the rebuilt subprocess, waiting for input. */
function neverEnds(): any {
  return {
    close() {},
    [Symbol.asyncIterator]() { return this; },
    next() { return new Promise(() => {}); },
  };
}

/** Yields `items`, then dies the way a killed CLI does. */
function thenCrashes(items: Array<Record<string, unknown>>): any {
  let i = 0;
  return {
    close() {},
    [Symbol.asyncIterator]() { return this; },
    async next() {
      await new Promise((r) => setTimeout(r, 5));
      if (i < items.length) return { done: false, value: items[i++] };
      throw new Error("Claude Code process exited with code 9");
    },
  };
}

const COMPLETED_TURN = [
  { type: "assistant", message: { content: [{ type: "text", text: "published" }] } },
  { type: "result" },
];

/** The text of a message the provider pushed into a subprocess's input stream. */
function pushedText(m: any): string {
  const c = m?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
  return "";
}

/**
 * Run one `sendMessage` against a scripted sequence of subprocesses and collect what was pushed
 * into each one. Returns once the retry has had time to push, then cancels the turn.
 */
async function runWithCrash(opening: string, streams: Array<() => any>) {
  const provider = new ClaudeAgentSdkProvider();
  const pushed: string[][] = [];
  let calls = 0;

  mockQueryFn.mockImplementation((args: any) => {
    const seen: string[] = [];
    pushed.push(seen);
    // The prompt is the input stream the provider pushes user messages into.
    void (async () => {
      try { for await (const m of args.prompt) seen.push(pushedText(m)); } catch { /* closed */ }
    })();
    const make = streams[calls] ?? neverEnds;
    calls++;
    return make();
  });

  const session = await provider.createSession({});
  const events: ChatEvent[] = [];
  const run = (async () => {
    try { for await (const e of provider.sendMessage(session.id, opening)) events.push(e); } catch { /* aborted */ }
  })();

  // The retry waits 1 s before respawning (claude-agent-sdk.ts), so give it room.
  await new Promise((r) => setTimeout(r, 2500));
  provider.abortQuery(session.id, "test");
  await Promise.race([run, new Promise((r) => setTimeout(r, 1000))]);

  return { pushed, calls, events };
}

describe("a crashed subprocess is retried", () => {
  beforeEach(() => { mockQueryFn.mockReset(); });

  it("re-sends nothing when the crash came after the turn had finished", async () => {
    const opening = "release the mem fix";
    const { pushed, calls } = await runWithCrash(opening, [
      () => thenCrashes(COMPLETED_TURN), // turn completes, then the CLI dies while idle
      () => neverEnds(),                 // the rebuilt subprocess
    ]);

    expect(calls).toBe(2); // the crash was retried
    expect(pushed[0]).toContain(opening); // the original subprocess got the instruction

    // The whole bug: the rebuilt subprocess must not be handed the finished instruction again.
    expect(pushed[1] ?? []).not.toContain(opening);
    expect(pushed[1] ?? []).toEqual([]);
  });

  it("resumes rather than re-sends when the crash interrupted a turn that had produced output", async () => {
    const opening = "deploy to production";
    const { pushed, calls } = await runWithCrash(opening, [
      // Output, but no `result`: the turn was still running when the CLI died.
      () => thenCrashes([{ type: "assistant", message: { content: [{ type: "text", text: "working" }] } }]),
      () => neverEnds(),
    ]);

    expect(calls).toBe(2);
    expect(pushed[0]).toContain(opening);

    // Resuming is correct here, but it must be the nudge — never the instruction itself, which
    // would restart the turn and re-run whatever it had already begun.
    expect(pushed[1] ?? []).not.toContain(opening);
    expect(pushed[1] ?? []).toContain("Continue from where you left off.");
  });

  it("re-sends the instruction when the crash came before the turn produced anything", async () => {
    const opening = "summarise the changelog";
    const { pushed, calls } = await runWithCrash(opening, [
      () => thenCrashes([]), // dies before emitting a single event
      () => neverEnds(),
    ]);

    expect(calls).toBe(2);
    expect(pushed[0]).toContain(opening);

    // Nothing reached the model, so re-sending is the only way the turn happens at all.
    expect(pushed[1] ?? []).toContain(opening);
  });
});
