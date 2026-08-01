import { describe, it, expect } from "bun:test";
import {
  parseResponders,
  buildRouterPrompt,
  makeResponderRouter,
  ROUTER_MODEL,
  type RouterBackend,
} from "../../src/services/group-chat/responder-router.ts";
import type { GroupMember, GroupMessage } from "../../src/types/group-chat.ts";

function member(name: string, role: "leader" | "member" = "member", persona: string | null = null): GroupMember {
  return {
    id: name, groupId: "g", role, persona, agentType: null, model: null,
    sessionId: `sess-${name}`, name, color: null, status: "idle", joinedAt: 0,
  };
}

const LEAD = member("lead", "leader", "facilitator");
const ALICE = member("alice", "member", "backend");
const BOB = member("bob", "member", "frontend");
const MEMBERS = [LEAD, ALICE, BOB];

function history(): GroupMessage[] {
  return [
    { id: "m1", groupId: "g", fromMember: "user", toMember: null, kind: "chat", summary: "hi team", fullSessionRef: null, data: null, turnIndex: 0, createdAt: 1 },
  ];
}

describe("parseResponders", () => {
  it("matches an exact member name", () => {
    expect(parseResponders("alice", MEMBERS)).toEqual(["alice"]);
  });
  it("is case-insensitive", () => {
    expect(parseResponders("ALICE", MEMBERS)).toEqual(["alice"]);
  });
  it("matches a name embedded in a sentence", () => {
    expect(parseResponders("I think bob should take this", MEMBERS)).toEqual(["bob"]);
  });
  it("returns multiple names in order of appearance", () => {
    expect(parseResponders("bob and alice both", MEMBERS)).toEqual(["bob", "alice"]);
  });
  it("returns [] for NONE / unknown / garbage / empty", () => {
    expect(parseResponders("NONE", MEMBERS)).toEqual([]);
    expect(parseResponders("ghost", MEMBERS)).toEqual([]);
    expect(parseResponders("nobody here", MEMBERS)).toEqual([]);
    expect(parseResponders("", MEMBERS)).toEqual([]);
  });
});

describe("buildRouterPrompt", () => {
  it("includes members, personas, the leader rule, and the name list", () => {
    const p = buildRouterPrompt(history(), MEMBERS, false);
    expect(p).toContain("alice");
    expect(p).toContain("backend");   // persona
    expect(p).toContain("lead");      // leader referenced
    expect(p).toContain("NONE");      // AI turn can end
  });
  it("forces a pick on a user turn (no NONE option)", () => {
    const p = buildRouterPrompt(history(), MEMBERS, true);
    expect(p).toContain("MUST pick at least one");
  });
  it("mentions parallelism on any turn", () => {
    expect(buildRouterPrompt(history(), MEMBERS, false)).toContain("PARALLELISM");
  });
});

/** Fake backend that yields scripted events and records the model used. */
function fakeBackend(events: Array<{ type: string; content?: string }>, opts: { throws?: boolean } = {}): {
  backend: RouterBackend; captured: { model?: string };
} {
  const captured: { model?: string } = {};
  const backend: RouterBackend = {
    async *sendMessage(_pid, _sid, _prompt, o) {
      captured.model = o?.model;
      if (opts.throws) throw new Error("boom");
      for (const e of events) yield e;
    },
  };
  return { backend, captured };
}

describe("makeResponderRouter", () => {
  it("returns parsed members and uses the cheapest model", async () => {
    const { backend, captured } = fakeBackend([{ type: "text", content: "alice bob" }, { type: "done" }]);
    const route = makeResponderRouter(backend, "claude", "router-sess");
    const names = await route({ history: history(), members: MEMBERS, isUserTurn: true });
    expect(names).toEqual(["alice", "bob"]);
    expect(captured.model).toBe(ROUTER_MODEL);
  });
  it("returns [] when the backend throws", async () => {
    const { backend } = fakeBackend([], { throws: true });
    const route = makeResponderRouter(backend, "claude", "router-sess");
    expect(await route({ history: history(), members: MEMBERS, isUserTurn: false })).toEqual([]);
  });
  it("returns [] on an error event", async () => {
    const { backend } = fakeBackend([{ type: "error", content: "auth" }]);
    const route = makeResponderRouter(backend, "claude", "router-sess");
    expect(await route({ history: history(), members: MEMBERS, isUserTurn: false })).toEqual([]);
  });
  it("returns [] when the reply names no known member", async () => {
    const { backend } = fakeBackend([{ type: "text", content: "NONE" }, { type: "done" }]);
    const route = makeResponderRouter(backend, "claude", "router-sess");
    expect(await route({ history: history(), members: MEMBERS, isUserTurn: false })).toEqual([]);
  });
});
