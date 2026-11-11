import { expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { chatWebSocket, dropIdleSubprocess } from "../../../src/server/ws/chat.ts";

// 2026-11-10: a spec turn's Antigravity session migrated to its real id; a browser then opened and
// closed a socket under the OLD id. That socket's fresh, idle entry released "its" subprocess on
// close — and the provider resolves the old id to the live session, so the running turn was cut
// with `cache_expired`.
it("closing a socket opened under a session's old id does not abort the turn running under its new id", async () => {
  const session = await chatService.createSession("mock", {});
  const newId = `migrated-${session.id}`;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const send = spyOn(chatService, "sendMessage").mockImplementation(async function* () {
    yield { type: "session_migrated", oldSessionId: session.id, newSessionId: newId } as any;
    yield { type: "text", content: "working" } as any;
    await gate;
  });
  // Like every real provider, the mock answers for an id it has migrated away from.
  const provider = providerRegistry.get("mock") as any;
  const hadStreaming = "hasStreamingSession" in provider;
  provider.hasStreamingSession = (id: string) => id === session.id || id === newId;
  const abort = spyOn(chatService, "abortQuery").mockImplementation(() => {});

  const messages: any[] = [];
  const runner = { data: { sessionId: session.id }, send: (json: string) => messages.push(JSON.parse(json)) };
  chatWebSocket.open(runner as any);
  const stale = { data: { sessionId: session.id }, send: () => {} };
  try {
    await chatWebSocket.message(runner as any, JSON.stringify({ type: "message", content: "go" }));
    for (let i = 0; i < 100 && !messages.some((m) => m.type === "text"); i++) await Bun.sleep(5);
    expect(runner.data.sessionId).toBe(newId);
    // The tab that started the turn goes away; the turn keeps running with nobody watching.
    chatWebSocket.close(runner as any);

    // A tab that missed the migration opens the old id and closes at once.
    chatWebSocket.open(stale as any);
    chatWebSocket.close(stale as any);

    expect(abort.mock.calls.map((c) => [c[1], c[2]])).toEqual([]);
  } finally {
    release();
    send.mockRestore();
    abort.mockRestore();
    if (!hadStreaming) delete provider.hasStreamingSession;
  }
});

// hienlh's review of #89: `dropIdleSubprocess` (a Codex account switch, re-sending after an
// oversized image is removed) is another door that reaches the provider under the old id. Codex
// migrates every session id on its first turn, so a tab that missed the notice could cut the
// running turn by switching accounts.
it("dropping the subprocess of a session's old id does not abort the turn running under its new id", async () => {
  const session = await chatService.createSession("mock", {});
  const newId = `migrated-${session.id}`;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const send = spyOn(chatService, "sendMessage").mockImplementation(async function* () {
    yield { type: "session_migrated", oldSessionId: session.id, newSessionId: newId } as any;
    yield { type: "text", content: "working" } as any;
    await gate;
  });
  const provider = providerRegistry.get("mock") as any;
  const hadStreaming = "hasStreamingSession" in provider;
  provider.hasStreamingSession = (id: string) => id === session.id || id === newId;
  const abort = spyOn(chatService, "abortQuery").mockImplementation(() => {});

  const messages: any[] = [];
  const runner = { data: { sessionId: session.id }, send: (json: string) => messages.push(JSON.parse(json)) };
  chatWebSocket.open(runner as any);
  const stale = { data: { sessionId: session.id }, send: () => {} };
  try {
    await chatWebSocket.message(runner as any, JSON.stringify({ type: "message", content: "go" }));
    for (let i = 0; i < 100 && !messages.some((m) => m.type === "text"); i++) await Bun.sleep(5);
    expect(runner.data.sessionId).toBe(newId);

    // A tab that missed the migration is still on the old id, and switches account there.
    chatWebSocket.open(stale as any);
    dropIdleSubprocess(session.id, "account_switch", "test");

    expect(abort.mock.calls.map((c) => [c[1], c[2]])).toEqual([]);
    // The live id itself can still be dropped: the guard only skips the stale alias.
    dropIdleSubprocess(newId, "account_switch", "test");
    expect(abort.mock.calls.map((c) => [c[1], c[2]])).toEqual([[newId, "account_switch"]]);
  } finally {
    chatWebSocket.close(stale as any);
    chatWebSocket.close(runner as any);
    release();
    send.mockRestore();
    abort.mockRestore();
    if (!hadStreaming) delete provider.hasStreamingSession;
  }
});
