/**
 * Which browser message a Claude turn is bound to, across the ways a subprocess ends.
 *
 * A pushed prompt waits in the binder until the CLI submits it. When the CLI is killed first —
 * Stop, a model change, an idle release, a crash — it never will, and a stale entry would bind the
 * next prompt with the same words ("continue", "yes") to the old, never-answered message.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

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

const PROMPT_ID = "55555555-0000-4000-8000-000000000001";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function neverEnds(): any {
  return { close() {}, [Symbol.asyncIterator]() { return this; }, next() { return new Promise(() => {}); } };
}

/** Dies the way a killed CLI does, before the turn produced anything. */
function crashesAtOnce(): any {
  return {
    close() {},
    [Symbol.asyncIterator]() { return this; },
    async next() { await wait(5); throw new Error("Claude Code process exited with code 9"); },
  };
}

/**
 * Starts a turn and keeps draining it in the background; resolves once the CLI is running. The
 * drain is handed back inside an object: returned bare, `await` would wait for the turn to end.
 */
async function startTurn(provider: any, sessionId: string, text: string, clientMessageId: string): Promise<{ done: Promise<void> }> {
  const done = (async () => {
    try { for await (const _ of provider.sendMessage(sessionId, text, { clientMessageId })) { /* drain */ } } catch { /* aborted */ }
  })();
  await wait(50);
  return { done };
}

/** Lets an ended turn finish draining, without waiting on one that never will. */
const settle = (turn: { done: Promise<void> }) => Promise.race([turn.done, wait(500)]);

describe("Claude prompt bindings when the subprocess ends", () => {
  beforeEach(() => { mockQueryFn.mockReset(); mockQueryFn.mockImplementation(() => neverEnds()); });

  it("after Stop, the same words sent again bind to the new message", async () => {
    const provider: any = new ClaudeAgentSdkProvider();
    const { id } = await provider.createSession({});
    const first = await startTurn(provider, id, "continue", "msg-old");
    provider.abortQuery(id, "ws_cancel");
    await settle(first);

    const second = await startTurn(provider, id, "continue", "msg-new");
    expect(provider.turnBinder.bind(id, PROMPT_ID, "continue")).toEqual({ turnId: PROMPT_ID, clientMessageId: "msg-new" });
    provider.abortQuery(id, "test");
    await settle(second);
  });

  it("closing the stream drops what it never submitted", async () => {
    const provider: any = new ClaudeAgentSdkProvider();
    const { id } = await provider.createSession({});
    const run = await startTurn(provider, id, "yes", "msg-1");
    provider.closeStreamingSession(id);
    await settle(run);
    expect(provider.turnBinder.bind(id, PROMPT_ID, "yes")).toBeNull();
  });

  it("a crash retry re-sends the prompt under the browser message it came from, once", async () => {
    const provider: any = new ClaudeAgentSdkProvider();
    const { id } = await provider.createSession({});
    let calls = 0;
    mockQueryFn.mockImplementation((args: any) => {
      void (async () => { try { for await (const _ of args.prompt) { /* consume */ } } catch { /* closed */ } })();
      return calls++ === 0 ? crashesAtOnce() : neverEnds();
    });
    const run = await startTurn(provider, id, "summarise the changelog", "msg-c");
    await wait(1500); // the retry waits 1 s before respawning
    expect(calls).toBe(2);
    expect(provider.turnBinder.bind(id, PROMPT_ID, "summarise the changelog")).toEqual({ turnId: PROMPT_ID, clientMessageId: "msg-c" });
    expect(provider.turnBinder.bind(id, "55555555-0000-4000-8000-000000000002", "summarise the changelog")).toBeNull();
    provider.abortQuery(id, "test");
    await settle(run);
  });
});
