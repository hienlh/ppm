import { describe, it, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { selectNextSpeaker, runGroupTurnLoop } from "../../src/services/group-chat/turn-engine.ts";
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

/** In-memory bus + scripted runner harness. `script` maps speaker name → queue of replies. */
function makeDeps(script: Record<string, string[]>, opts: {
  costPerTurn?: number;
  stopAfter?: number;
} = {}): { deps: TurnEngineDeps; bus: GroupMessage[]; calls: string[] } {
  const bus: GroupMessage[] = [];
  const calls: string[] = [];
  const queues: Record<string, string[]> = {};
  for (const k of Object.keys(script)) queues[k] = [...script[k]];
  let turnCount = 0;

  const deps: TurnEngineDeps = {
    async runAgent(m: GroupMember): Promise<AgentTurnResult> {
      calls.push(m.name);
      const text = queues[m.name]?.shift() ?? "(silence)";
      return { text, usage: { costUsd: opts.costPerTurn ?? 0 } };
    },
    appendMessage(input: AppendMessageInput): GroupMessage {
      const msg: GroupMessage = {
        id: randomUUID(), groupId: input.groupId, fromMember: input.fromMember,
        toMember: input.toMember ?? null, kind: input.kind, summary: input.summary ?? null,
        fullSessionRef: input.fullSessionRef ?? null, data: input.data ?? null,
        turnIndex: input.turnIndex, createdAt: Date.now(),
      };
      bus.push(msg);
      return msg;
    },
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
  return { deps, bus, calls };
}

describe("selectNextSpeaker", () => {
  it("routes to an @mentioned member", () => {
    expect(selectNextSpeaker("thoughts @bob?", "lead", MEMBERS)).toBe("bob");
  });
  it("ignores self-mention and falls back", () => {
    expect(selectNextSpeaker("@lead thinking", "lead", MEMBERS)).toBe("alice");
  });
  it("ignores unknown mention, falls back to leader from a member", () => {
    expect(selectNextSpeaker("@nobody here", "alice", MEMBERS)).toBe("lead");
  });
  it("no mention: leader picks first member, member picks leader", () => {
    expect(selectNextSpeaker("just talking", "lead", MEMBERS)).toBe("alice");
    expect(selectNextSpeaker("just talking", "alice", MEMBERS)).toBe("lead");
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

describe("runGroupTurnLoop", () => {
  it("stops when leader emits DONE and marks a single final", async () => {
    const { deps, bus } = makeDeps({
      lead: ["Let's discuss. @alice your take?", "DONE: use one table. simpler."],
      alice: ["I think one table works @lead"],
    });
    const res = await runGroupTurnLoop(makeGroup(), MEMBERS, deps, "How to store the bus?");
    expect(res.reason).toBe("leader_done");
    const finals = bus.filter((m) => m.kind === "final");
    expect(finals.length).toBe(1);
    expect(finals[0].fromMember).toBe("lead");
  });

  it("max-turns cap forces a leader final then stops", async () => {
    // Never emits DONE naturally; everyone just chats.
    const chatty = Array.from({ length: 20 }, (_, i) => `talk ${i} @bob`);
    const { deps, bus } = makeDeps({ lead: chatty, alice: chatty, bob: chatty });
    const res = await runGroupTurnLoop(makeGroup({ maxTurns: 6 }), MEMBERS, deps, "task");
    expect(res.reason).toBe("max_turns");
    expect(res.turns).toBeLessThanOrEqual(6);
    const finals = bus.filter((m) => m.kind === "final");
    expect(finals.length).toBe(1);
    expect(finals[0].fromMember).toBe("lead");
  });

  it("budget cap stops the loop with a final", async () => {
    const chatty = Array.from({ length: 50 }, () => "more talk @alice");
    const { deps, bus } = makeDeps(
      { lead: chatty, alice: chatty, bob: chatty },
      { costPerTurn: 1.0 },
    );
    const res = await runGroupTurnLoop(makeGroup({ maxCostUsd: 2.5, maxTurns: 40 }), MEMBERS, deps, "task");
    expect(res.reason).toBe("budget");
    expect(res.costUsd).toBeGreaterThanOrEqual(2.5);
    expect(bus.filter((m) => m.kind === "final").length).toBe(1);
  });

  it("external stop signal halts mid-loop", async () => {
    const chatty = Array.from({ length: 50 }, () => "talk @bob");
    const { deps, bus } = makeDeps(
      { lead: chatty, alice: chatty, bob: chatty },
      { stopAfter: 3 },
    );
    const res = await runGroupTurnLoop(makeGroup({ maxTurns: 40 }), MEMBERS, deps, "task");
    expect(res.reason).toBe("stopped");
    expect(res.turns).toBeLessThanOrEqual(4);
    expect(bus.filter((m) => m.kind === "final").length).toBe(1);
  });

  it("emits every turn via onMessage and persists to the bus", async () => {
    const emitted: GroupMessage[] = [];
    const { deps, bus } = makeDeps({
      lead: ["kickoff @alice", "DONE: decided"],
      alice: ["reply @lead"],
    });
    deps.onMessage = (m) => emitted.push(m);
    await runGroupTurnLoop(makeGroup(), MEMBERS, deps, "task");
    expect(emitted.length).toBe(bus.length);
    expect(emitted.length).toBeGreaterThan(0);
  });

  it("caps the feed summary — bus never stores unbounded full turn text", async () => {
    const huge = "word ".repeat(4000); // ~20k chars, one paragraph
    const { deps, bus } = makeDeps({
      lead: [`${huge} @alice`, "DONE: decided"],
      alice: [`${huge} @lead`],
    });
    await runGroupTurnLoop(makeGroup(), MEMBERS, deps, "task");
    for (const m of bus) {
      expect((m.summary ?? "").length).toBeLessThanOrEqual(601); // cap + ellipsis
    }
  });
});
