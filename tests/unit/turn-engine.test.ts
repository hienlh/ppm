import { describe, it, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  selectNextSpeaker,
  selectInitialResponders,
  runReplyBurst,
  buildTurnContext,
  REPLY_BURST_CAP,
} from "../../src/services/group-chat/turn-engine.ts";
import { buildContextWindow } from "../../src/services/group-chat/context-window.ts";
import type {
  Group,
  GroupMember,
  GroupMessage,
  AppendMessageInput,
  TurnEngineDeps,
  AgentTurnResult,
} from "../../src/types/group-chat.ts";

function member(name: string, role: "leader" | "member"): GroupMember {
  return {
    id: name, groupId: "g", role, persona: null, agentType: null, model: null,
    sessionId: `sess-${name}`, name, color: null, status: "idle", joinedAt: 0,
  };
}

const LEAD = member("lead", "leader");
const ALICE = member("alice", "member");
const BOB = member("bob", "member");
const MEMBERS = [LEAD, ALICE, BOB];

function makeGroup(overrides: Partial<Group> = {}): Group {
  return {
    id: "g", projectName: "p", projectPath: "/p", name: "G", leaderSessionId: "sess-lead",
    status: "active", maxTurns: 40, maxCostUsd: 5.0, createdAt: 0, ...overrides,
  };
}

/**
 * In-memory bus + scripted runner harness. `script` maps speaker name → queue of
 * replies. Seeds the bus with a user message so the burst can pick responders.
 */
function makeDeps(userText: string, script: Record<string, string[]>, opts: {
  costPerTurn?: number;
  stopAfter?: number;
  /** Scripted router: receives isUserTurn, returns the next speaker name(s) to run in
   *  parallel (or [] to end). A bare string is treated as a single-element batch. */
  router?: (ctx: { isUserTurn: boolean; history: GroupMessage[]; members: GroupMember[] }) => string | string[] | null;
} = {}): { deps: TurnEngineDeps; bus: GroupMessage[]; calls: string[]; routerCalls: Array<{ isUserTurn: boolean }> } {
  const bus: GroupMessage[] = [];
  const calls: string[] = [];
  const routerCalls: Array<{ isUserTurn: boolean }> = [];
  const queues: Record<string, string[]> = {};
  for (const k of Object.keys(script)) queues[k] = [...script[k]];
  let turnCount = 0;
  let idx = 0;

  const append = (input: AppendMessageInput): GroupMessage => {
    const msg: GroupMessage = {
      id: randomUUID(), groupId: input.groupId, fromMember: input.fromMember,
      toMember: input.toMember ?? null, kind: input.kind, summary: input.summary ?? null,
      fullSessionRef: input.fullSessionRef ?? null, data: input.data ?? null,
      turnIndex: input.turnIndex, createdAt: Date.now(),
    };
    bus.push(msg);
    return msg;
  };

  // Seed the user's message (as the service does before a burst).
  append({ groupId: "g", fromMember: "user", kind: "chat", summary: userText, turnIndex: idx++ });

  const deps: TurnEngineDeps = {
    async runAgent(m: GroupMember): Promise<AgentTurnResult> {
      calls.push(m.name);
      const text = queues[m.name]?.shift() ?? "(silence)";
      return { text, usage: { costUsd: opts.costPerTurn ?? 0 } };
    },
    appendMessage: append,
    readMessages(_g, o) {
      let out = bus.slice();
      if (o?.sinceTurn !== undefined) out = out.filter((m) => m.turnIndex > o.sinceTurn!);
      if (o?.limit !== undefined) out = out.slice(-o.limit);
      return out;
    },
    shouldStop() {
      turnCount++;
      return opts.stopAfter !== undefined && turnCount > opts.stopAfter;
    },
  };
  if (opts.router) {
    deps.routeNextSpeakers = async (ctx) => {
      routerCalls.push({ isUserTurn: ctx.isUserTurn });
      const r = opts.router!(ctx);
      return r == null ? [] : Array.isArray(r) ? r : [r];
    };
  }
  return { deps, bus, calls, routerCalls };
}

/** Assistant (non-user) messages appended during the burst. */
function replies(bus: GroupMessage[]): GroupMessage[] {
  return bus.filter((m) => m.fromMember !== "user");
}

describe("selectInitialResponders", () => {
  it("no mention → leader replies", () => {
    expect(selectInitialResponders("hello everyone", MEMBERS)).toEqual(["lead"]);
  });
  it("@mention → that member replies", () => {
    expect(selectInitialResponders("hey @bob what's up", MEMBERS)).toEqual(["bob"]);
  });
  it("multiple mentions → each once, in order, deduped", () => {
    expect(selectInitialResponders("@alice and @bob and @alice", MEMBERS)).toEqual(["alice", "bob"]);
  });
  it("unknown mention → falls back to leader", () => {
    expect(selectInitialResponders("@nobody hi", MEMBERS)).toEqual(["lead"]);
  });
});

describe("selectNextSpeaker", () => {
  it("returns an @mentioned teammate", () => {
    expect(selectNextSpeaker("thoughts @bob?", "lead", MEMBERS)).toBe("bob");
  });
  it("returns null on self-mention (addressed to user, no teammate pull)", () => {
    expect(selectNextSpeaker("@lead thinking", "lead", MEMBERS)).toBeNull();
  });
  it("returns null on unknown mention", () => {
    expect(selectNextSpeaker("@nobody here", "alice", MEMBERS)).toBeNull();
  });
  it("returns null when there is no mention", () => {
    expect(selectNextSpeaker("just replying to you", "lead", MEMBERS)).toBeNull();
  });
});

describe("buildContextWindow", () => {
  it("windows to last-N and summarizes older turns", () => {
    const msgs: GroupMessage[] = Array.from({ length: 12 }, (_, i) => ({
      id: `m${i}`, groupId: "g", fromMember: "x", toMember: null, kind: "chat",
      summary: `turn ${i}`, fullSessionRef: null, data: null, turnIndex: i, createdAt: i,
    }));
    const { window, rollingSummary } = buildContextWindow(msgs, 8);
    expect(window.length).toBe(8);
    expect(window[0].turnIndex).toBe(4);
    expect(rollingSummary).toContain("turn 0");
    expect(rollingSummary).toContain("turn 3");
    expect(rollingSummary).not.toContain("turn 4");
  });
});

describe("runReplyBurst", () => {
  it("no-mention message: only the leader replies once, then ends", async () => {
    const { deps, bus, calls } = makeDeps("Hú", { lead: ["Chào bạn, có gì không?"] });
    const res = await runReplyBurst(makeGroup(), MEMBERS, deps);
    expect(calls).toEqual(["lead"]);
    expect(res.turns).toBe(1);
    expect(res.reason).toBe("no_more_mentions");
    expect(replies(bus).map((m) => m.fromMember)).toEqual(["lead"]);
    expect(replies(bus)[0].kind).toBe("chat");
  });

  it("@mentioned member replies (no further mention) then ends", async () => {
    const { deps, bus, calls } = makeDeps("@bob bạn nghĩ sao?", { bob: ["Mình thấy ổn."] });
    const res = await runReplyBurst(makeGroup(), MEMBERS, deps);
    expect(calls).toEqual(["bob"]);
    expect(res.turns).toBe(1);
    expect(res.reason).toBe("no_more_mentions");
  });

  it("follows @mentions across members, bounded by the cap", async () => {
    // lead → @bob → @lead → @bob ... cap must stop it at REPLY_BURST_CAP.
    const chatty = Array.from({ length: 10 }, () => "tiếp tục @bob");
    const { deps, calls } = makeDeps("@lead mở màn đi", {
      lead: chatty, bob: Array.from({ length: 10 }, () => "phản hồi @lead"),
    });
    const res = await runReplyBurst(makeGroup(), MEMBERS, deps);
    expect(res.turns).toBe(REPLY_BURST_CAP);
    expect(res.reason).toBe("cap_reached");
    expect(calls.length).toBe(REPLY_BURST_CAP);
  });

  it("stop-early: a reply with no teammate mention ends the burst under the cap", async () => {
    const { deps, calls } = makeDeps("@alice mở màn", {
      alice: ["Trả lời bạn thôi, không gọi ai."], // no mention → stop
    });
    const res = await runReplyBurst(makeGroup(), MEMBERS, deps);
    expect(calls).toEqual(["alice"]);
    expect(res.turns).toBe(1);
    expect(res.reason).toBe("no_more_mentions");
  });

  it("external stop halts the burst", async () => {
    const chatty = Array.from({ length: 10 }, () => "nói tiếp @bob");
    const { deps } = makeDeps("@lead đi", {
      lead: chatty, bob: Array.from({ length: 10 }, () => "ok @lead"),
    }, { stopAfter: 1 });
    const res = await runReplyBurst(makeGroup(), MEMBERS, deps);
    expect(res.reason).toBe("stopped");
    expect(res.turns).toBeLessThanOrEqual(REPLY_BURST_CAP);
  });

  it("never emits a final message and always uses kind:'chat'", async () => {
    const { deps, bus } = makeDeps("@lead xin chào", {
      lead: ["chào @bob"], bob: ["hi cả nhà"],
    });
    await runReplyBurst(makeGroup(), MEMBERS, deps);
    expect(bus.some((m) => m.kind === "final")).toBe(false);
    expect(replies(bus).every((m) => m.kind === "chat")).toBe(true);
  });

  it("signals onTyping for each speaker right before their turn", async () => {
    const typing: string[] = [];
    const { deps } = makeDeps("@lead hi", { lead: ["chào @bob"], bob: ["hi cả nhà"] });
    deps.onTyping = (m) => typing.push(m);
    await runReplyBurst(makeGroup(), MEMBERS, deps);
    expect(typing).toEqual(["lead", "bob"]);
  });

  it("emits every reply via onMessage", async () => {
    const emitted: GroupMessage[] = [];
    const { deps, bus } = makeDeps("@lead hi", { lead: ["chào @bob"], bob: ["hi"] });
    deps.onMessage = (m) => emitted.push(m);
    await runReplyBurst(makeGroup(), MEMBERS, deps);
    expect(emitted.length).toBe(replies(bus).length);
    expect(emitted.length).toBeGreaterThan(0);
  });

  it("caps the feed summary length", async () => {
    const huge = "word ".repeat(4000);
    const { deps, bus } = makeDeps("@lead nói dài đi", { lead: [huge] });
    await runReplyBurst(makeGroup(), MEMBERS, deps);
    for (const m of replies(bus)) {
      expect((m.summary ?? "").length).toBeLessThanOrEqual(601);
    }
  });
});

describe("runReplyBurst (router-driven)", () => {
  /** Returns a router fn yielding the scripted sequence, then null. */
  function scriptRouter(seq: Array<string | null>) {
    let i = 0;
    return () => (i < seq.length ? seq[i++] : null);
  }

  it("router picks the speaker each turn; first call is the user turn", async () => {
    const { deps, calls, routerCalls } = makeDeps("câu chung", { alice: ["ừ"] }, {
      router: scriptRouter(["alice", null]),
    });
    const res = await runReplyBurst(makeGroup(), MEMBERS, deps);
    expect(calls).toEqual(["alice"]);
    expect(res.turns).toBe(1);
    expect(routerCalls[0]!.isUserTurn).toBe(true);
  });

  it("forces the leader when the router returns null on the user turn (≥1 reply)", async () => {
    const { deps, calls } = makeDeps("hi", { lead: ["chào"] }, { router: () => null });
    const res = await runReplyBurst(makeGroup(), MEMBERS, deps);
    expect(calls).toEqual(["lead"]);
    expect(res.turns).toBe(1);
  });

  it("continues an AI thread by context, then ends on router null (silence)", async () => {
    const { deps, calls } = makeDeps("chung", { alice: ["a"], bob: ["b"] }, {
      router: scriptRouter(["alice", "bob", null]),
    });
    const res = await runReplyBurst(makeGroup(), MEMBERS, deps);
    expect(calls).toEqual(["alice", "bob"]);
    expect(res.turns).toBe(2);
    expect(res.reason).toBe("no_more_mentions");
  });

  it("AI-turn silence: router null right after the user reply ends the burst", async () => {
    const { deps, calls } = makeDeps("chung", { alice: ["a"] }, { router: scriptRouter(["alice", null]) });
    const res = await runReplyBurst(makeGroup(), MEMBERS, deps);
    expect(calls).toEqual(["alice"]);
    expect(res.turns).toBe(1);
  });

  it("respects the cap even if the router keeps returning names", async () => {
    const { deps, calls } = makeDeps("chung", { lead: ["x"], alice: ["y"], bob: ["z"] }, {
      router: () => "alice",
    });
    const res = await runReplyBurst(makeGroup(), MEMBERS, deps);
    expect(res.turns).toBe(REPLY_BURST_CAP);
    expect(res.reason).toBe("cap_reached");
    expect(calls.length).toBe(REPLY_BURST_CAP);
  });

  it("user @mention bypasses the router for that turn", async () => {
    const { deps, calls, routerCalls } = makeDeps("@bob giúp mình", { bob: ["ok"] }, {
      router: () => null, // must NOT be consulted for the mention turn
    });
    const res = await runReplyBurst(makeGroup(), MEMBERS, deps);
    expect(calls).toEqual(["bob"]);
    expect(res.turns).toBe(1);
    expect(routerCalls.every((c) => !c.isUserTurn)).toBe(true);
  });

  it("ignores an unknown router name (treated as null → leader on user turn)", async () => {
    const { deps, calls } = makeDeps("hi", { lead: ["chào"] }, { router: () => "ghost" });
    const res = await runReplyBurst(makeGroup(), MEMBERS, deps);
    expect(calls).toEqual(["lead"]);
    expect(res.turns).toBe(1);
  });

  it("external stop halts the routed burst", async () => {
    const { deps } = makeDeps("chung", { alice: ["y"] }, { router: () => "alice", stopAfter: 1 });
    const res = await runReplyBurst(makeGroup(), MEMBERS, deps);
    expect(res.reason).toBe("stopped");
    expect(res.turns).toBeLessThanOrEqual(REPLY_BURST_CAP);
  });

  it("runs a parallel batch when the router returns multiple names", async () => {
    const seq: Array<string[]> = [["alice", "bob"], []];
    let i = 0;
    const { deps, calls } = makeDeps("làm 2 việc độc lập", { alice: ["a"], bob: ["b"] }, {
      router: () => seq[i++] ?? [],
    });
    const res = await runReplyBurst(makeGroup(), MEMBERS, deps);
    expect([...calls].sort()).toEqual(["alice", "bob"]);
    expect(res.turns).toBe(2);
    expect(res.reason).toBe("no_more_mentions");
  });

  it("user @mentions multiple members → one parallel batch (router bypassed)", async () => {
    const { deps, calls, routerCalls } = makeDeps("@alice @bob giúp mình", { alice: ["a"], bob: ["b"] }, {
      router: () => [],
    });
    const res = await runReplyBurst(makeGroup(), MEMBERS, deps);
    expect([...calls].sort()).toEqual(["alice", "bob"]);
    expect(res.turns).toBe(2);
    expect(routerCalls.every((c) => !c.isUserTurn)).toBe(true);
  });

  it("truncates a parallel batch to the remaining cap", async () => {
    const { deps, calls } = makeDeps("chung", { lead: ["x"], alice: ["y"], bob: ["z"] }, {
      router: () => ["lead", "alice", "bob"],
    });
    const res = await runReplyBurst(makeGroup(), MEMBERS, deps);
    expect(res.turns).toBe(REPLY_BURST_CAP);
    expect(res.reason).toBe("cap_reached");
    expect(calls.length).toBe(REPLY_BURST_CAP);
  });
});

describe("full-text bus + delta context", () => {
  function gmsg(from: string, summary: string, turnIndex: number, full?: string): GroupMessage {
    return {
      id: `m${turnIndex}`, groupId: "g", fromMember: from, toMember: null, kind: "chat",
      summary, fullSessionRef: null, data: full ? { full } : null, turnIndex, createdAt: turnIndex,
    };
  }
  function busDeps(bus: GroupMessage[]): TurnEngineDeps {
    return {
      readMessages: () => bus,
      runAgent: async () => ({ text: "" }),
      appendMessage: (i) => gmsg(i.fromMember, i.summary ?? "", i.turnIndex),
    };
  }

  it("stores full turn text in data.full while summary stays clipped", async () => {
    const long = "x".repeat(4000);
    const { deps, bus } = makeDeps("@lead nói dài", { lead: [long] });
    await runReplyBurst(makeGroup(), MEMBERS, deps);
    const reply = bus.find((m) => m.fromMember === "lead")!;
    expect((reply.data as { full?: string }).full).toBe(long);
    expect((reply.summary ?? "").length).toBeLessThanOrEqual(601);
  });

  it("buildTurnContext injects only the delta since the member last spoke (full text)", () => {
    const bus = [
      gmsg("user", "hỏi", 0, "hỏi đầy đủ"),
      gmsg("lead", "chào", 1, "chào full"),
      gmsg("alice", "yo", 2, "yo full"),
      gmsg("user", "tiếp", 3, "tiếp full"),
    ];
    const p = buildTurnContext(makeGroup(), LEAD, MEMBERS, busDeps(bus));
    expect(p).toContain("NEW SINCE YOU LAST SPOKE");
    expect(p).toContain("yo full");    // alice@2 is in the delta (full text)
    expect(p).toContain("tiếp full");  // user@3 is in the delta
    expect(p).not.toContain("chào");   // lead's own @1 turn is NOT re-injected
  });

  it("buildTurnContext falls back to the recent window on the member's first turn", () => {
    const bus = [gmsg("user", "xin chào", 0, "xin chào full")];
    const p = buildTurnContext(makeGroup(), BOB, MEMBERS, busDeps(bus));
    expect(p).toContain("GROUP CHAT (recent)");
    expect(p).toContain("xin chào full");
  });
});
