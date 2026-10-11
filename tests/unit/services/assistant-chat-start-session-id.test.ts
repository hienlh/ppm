/**
 * `chat_start` answers with the id a chat keeps. Codex renames a new chat during its first turn,
 * after the message was accepted, so for Codex the answer waits for that rename — bounded, and
 * cut short by a turn that ended without one.
 */
import { describe, expect, it } from "bun:test";
import { awaitCanonicalSessionId } from "../../../src/services/assistant-mcp/assistant-chat-start-session-id.ts";
import { createChatLifecycle } from "../../../src/services/chat-control/chat-lifecycle.ts";

const DRAFT = "draft-1";
const THREAD = "thread-1";

function harness() {
  const lifecycle = createChatLifecycle();
  const renamed = new Map<string, string>();
  const resolve = (id: string) => renamed.get(id) ?? id;
  const ended = { sessionId: DRAFT, outcome: "failed" as const, projectName: "api", providerId: "codex" };
  return { lifecycle, renamed, resolve, ended };
}

describe("awaitCanonicalSessionId", () => {
  it("answers at once for a provider that keeps its id, and for a chat already renamed", async () => {
    const h = harness();
    expect(await awaitCanonicalSessionId(DRAFT, "claude", { lifecycle: h.lifecycle, resolve: h.resolve, timeoutMs: 60_000 })).toBe(DRAFT);
    h.renamed.set(DRAFT, THREAD);
    expect(await awaitCanonicalSessionId(DRAFT, "codex", { lifecycle: h.lifecycle, resolve: h.resolve, timeoutMs: 60_000 })).toBe(THREAD);
    expect(h.lifecycle.has("migrated")).toBe(false);
  });

  it("waits for a Codex chat's rename and answers with the thread id", async () => {
    const h = harness();
    const pending = awaitCanonicalSessionId(DRAFT, "codex", { lifecycle: h.lifecycle, resolve: h.resolve, timeoutMs: 60_000 });
    // Another chat's rename is not this one's.
    h.lifecycle.emit("migrated", { oldSessionId: "other", newSessionId: "other-thread" });
    h.renamed.set(DRAFT, THREAD);
    h.lifecycle.emit("migrated", { oldSessionId: DRAFT, newSessionId: THREAD });
    expect(await pending).toBe(THREAD);
    // Nothing is left listening once it answered.
    expect(h.lifecycle.has("migrated")).toBe(false);
    expect(h.lifecycle.has("turn_ended")).toBe(false);
  });

  it("answers with the draft id when the turn ends unrenamed, or the wait runs out", async () => {
    const h = harness();
    const ended = awaitCanonicalSessionId(DRAFT, "codex", { lifecycle: h.lifecycle, resolve: h.resolve, timeoutMs: 60_000 });
    h.lifecycle.emit("turn_ended", h.ended);
    expect(await ended).toBe(DRAFT);

    const started = Date.now();
    expect(await awaitCanonicalSessionId(DRAFT, "codex", { lifecycle: h.lifecycle, resolve: h.resolve, timeoutMs: 20 })).toBe(DRAFT);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(h.lifecycle.has("migrated")).toBe(false);
  });
});
