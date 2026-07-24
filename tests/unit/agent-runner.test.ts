import { describe, it, expect } from "bun:test";
import { runAgentTurn, dispatchParallel } from "../../src/services/group-chat/agent-runner.ts";
import type { ChatBackend } from "../../src/services/group-chat/agent-runner.ts";
import type { GroupMember } from "../../src/types/group-chat.ts";

function member(name: string, sessionId: string | null = "sess"): GroupMember {
  return {
    id: name, groupId: "g", role: "member", persona: null, agentType: null, model: null,
    sessionId, name, color: null, status: "idle", joinedAt: 0,
  };
}

/** Mock backend yielding scripted text chunks then a done event with usage. */
function makeBackend(chunks: string[], costUsd = 0.01): ChatBackend {
  return {
    async createSession() { return { id: `sess-${Math.random().toString(36).slice(2)}` }; },
    async *sendMessage() {
      for (const c of chunks) yield { type: "text", content: c } as const;
      yield { type: "done", usage: { costUsd } } as const;
    },
  };
}

describe("runAgentTurn", () => {
  it("derives summary from concatenated full text, not the last chunk", async () => {
    const backend = makeBackend(["Hello ", "world. ", "Final sentence here."]);
    const res = await runAgentTurn(backend, "claude", member("alice"), "prompt");
    expect(res.full).toBe("Hello world. Final sentence here.");
    // Summary must reflect the whole answer, not just "Final sentence here."
    expect(res.summary).toContain("Hello world");
    expect(res.text).toBe(res.full);
  });

  it("caps the summary length", async () => {
    const long = "x".repeat(5000);
    const backend = makeBackend([long]);
    const res = await runAgentTurn(backend, "claude", member("alice"), "prompt");
    expect(res.summary.length).toBeLessThanOrEqual(600);
    expect(res.full.length).toBe(5000);
  });

  it("captures usage cost", async () => {
    const backend = makeBackend(["ok"], 0.25);
    const res = await runAgentTurn(backend, "claude", member("alice"), "prompt");
    expect(res.usage?.costUsd).toBe(0.25);
  });

  it("aborts cleanly when the signal is already aborted", async () => {
    const backend = makeBackend(["should not stream"]);
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await runAgentTurn(backend, "claude", member("alice"), "prompt", { signal: ctrl.signal });
    expect(res.full).toBe("");
  });
});

describe("dispatchParallel", () => {
  it("respects the concurrency cap", async () => {
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 10 }, (_, i) => async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return i;
    });
    const results = await dispatchParallel(tasks, 3);
    expect(results.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it("returns results in task order regardless of completion order", async () => {
    const tasks = [
      async () => { await new Promise((r) => setTimeout(r, 15)); return "a"; },
      async () => { await new Promise((r) => setTimeout(r, 1)); return "b"; },
      async () => { await new Promise((r) => setTimeout(r, 8)); return "c"; },
    ];
    const results = await dispatchParallel(tasks, 2);
    expect(results).toEqual(["a", "b", "c"]);
  });
});
