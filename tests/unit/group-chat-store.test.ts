import { describe, it, expect, beforeEach } from "bun:test";
import { openTestDb, setDb, getDb } from "../../src/services/db.service.ts";
import {
  createGroup,
  getGroup,
  listGroups,
  deleteGroup,
  setGroupStatus,
  setGroupLeaderSession,
  addMember,
  listMembers,
  setMemberSession,
  setMemberStatus,
  appendMessage,
  readMessages,
} from "../../src/services/group-chat/group-chat.store.ts";
import { DEFAULT_MAX_TURNS, DEFAULT_MAX_COST_USD } from "../../src/types/group-chat.ts";

describe("group-chat.store (SQLite)", () => {
  beforeEach(() => {
    setDb(openTestDb());
  });

  it("migration creates the three group-chat tables with expected columns", () => {
    const groupCols = (getDb().query("PRAGMA table_info(chat_groups)").all() as { name: string }[]).map((c) => c.name);
    expect(groupCols).toEqual(
      expect.arrayContaining(["id", "project_name", "project_path", "name", "leader_session_id", "status", "max_turns", "max_cost_usd", "created_at"]),
    );
    const memberCols = (getDb().query("PRAGMA table_info(chat_group_members)").all() as { name: string }[]).map((c) => c.name);
    expect(memberCols).toEqual(
      expect.arrayContaining(["id", "group_id", "role", "persona", "agent_type", "model", "session_id", "name", "color", "status", "joined_at"]),
    );
    const msgCols = (getDb().query("PRAGMA table_info(chat_group_messages)").all() as { name: string }[]).map((c) => c.name);
    expect(msgCols).toEqual(
      expect.arrayContaining(["id", "group_id", "from_member", "to_member", "kind", "summary", "full_session_ref", "data", "turn_index", "created_at"]),
    );
  });

  it("createGroup applies defaults and getGroup returns it", () => {
    const g = createGroup({ projectName: "demo", projectPath: "/tmp/demo", name: "Team A" });
    expect(g.id).toBeTruthy();
    expect(g.status).toBe("idle");
    expect(g.maxTurns).toBe(DEFAULT_MAX_TURNS);
    expect(g.maxCostUsd).toBe(DEFAULT_MAX_COST_USD);
    const fetched = getGroup(g.id);
    expect(fetched?.name).toBe("Team A");
    expect(fetched?.projectPath).toBe("/tmp/demo");
  });

  it("createGroup honors caps overrides", () => {
    const g = createGroup({ projectName: "demo", projectPath: "/tmp/demo", name: "T", maxTurns: 10, maxCostUsd: 1.5 });
    expect(g.maxTurns).toBe(10);
    expect(g.maxCostUsd).toBe(1.5);
  });

  it("listGroups is scoped by project path", () => {
    createGroup({ projectName: "a", projectPath: "/p/a", name: "GA" });
    createGroup({ projectName: "a", projectPath: "/p/a", name: "GA2" });
    createGroup({ projectName: "b", projectPath: "/p/b", name: "GB" });
    expect(listGroups("/p/a").length).toBe(2);
    expect(listGroups("/p/b").length).toBe(1);
    expect(listGroups("/p/none").length).toBe(0);
  });

  it("addMember + listMembers roundtrips persona/model/role", () => {
    const g = createGroup({ projectName: "a", projectPath: "/p/a", name: "G" });
    addMember({ groupId: g.id, role: "leader", name: "lead", persona: "facilitator", model: "opus" });
    addMember({ groupId: g.id, role: "member", name: "alice", persona: "backend", model: "sonnet", color: "#f00" });
    const members = listMembers(g.id);
    expect(members.length).toBe(2);
    const lead = members.find((m) => m.name === "lead")!;
    expect(lead.role).toBe("leader");
    expect(lead.persona).toBe("facilitator");
    const alice = members.find((m) => m.name === "alice")!;
    expect(alice.model).toBe("sonnet");
    expect(alice.color).toBe("#f00");
    expect(alice.status).toBe("idle");
  });

  it("setMemberSession / setMemberStatus / setGroupLeaderSession / setGroupStatus persist", () => {
    const g = createGroup({ projectName: "a", projectPath: "/p/a", name: "G" });
    const m = addMember({ groupId: g.id, role: "member", name: "alice" });
    setMemberSession(m.id, "sess-1");
    setMemberStatus(m.id, "working");
    const reloaded = listMembers(g.id).find((x) => x.id === m.id)!;
    expect(reloaded.sessionId).toBe("sess-1");
    expect(reloaded.status).toBe("working");

    setGroupLeaderSession(g.id, "leader-sess");
    setGroupStatus(g.id, "active");
    const gg = getGroup(g.id)!;
    expect(gg.leaderSessionId).toBe("leader-sess");
    expect(gg.status).toBe("active");
  });

  it("appendMessage + readMessages returns messages ordered, JSON data preserved", () => {
    const g = createGroup({ projectName: "a", projectPath: "/p/a", name: "G" });
    appendMessage({ groupId: g.id, fromMember: "lead", toMember: "alice", kind: "task", summary: "do X", turnIndex: 0, data: { foo: 1 } });
    appendMessage({ groupId: g.id, fromMember: "alice", toMember: "lead", kind: "chat", summary: "on it", turnIndex: 1 });
    const all = readMessages(g.id);
    expect(all.length).toBe(2);
    expect(all[0].fromMember).toBe("lead");
    expect(all[0].data).toEqual({ foo: 1 });
    expect(all[1].kind).toBe("chat");
  });

  it("readMessages windowing: limit returns last-N; sinceTurn filters", () => {
    const g = createGroup({ projectName: "a", projectPath: "/p/a", name: "G" });
    for (let i = 0; i < 10; i++) {
      appendMessage({ groupId: g.id, fromMember: "m", kind: "chat", summary: `t${i}`, turnIndex: i });
    }
    const last3 = readMessages(g.id, { limit: 3 });
    expect(last3.length).toBe(3);
    expect(last3.map((m) => m.turnIndex)).toEqual([7, 8, 9]);

    const since = readMessages(g.id, { sinceTurn: 7 });
    expect(since.map((m) => m.turnIndex)).toEqual([8, 9]);
  });

  it("deleteGroup cascades members + messages", () => {
    const g = createGroup({ projectName: "a", projectPath: "/p/a", name: "G" });
    addMember({ groupId: g.id, role: "member", name: "alice" });
    appendMessage({ groupId: g.id, fromMember: "alice", kind: "chat", summary: "hi", turnIndex: 0 });
    deleteGroup(g.id);
    expect(getGroup(g.id)).toBeNull();
    expect(listMembers(g.id).length).toBe(0);
    expect(readMessages(g.id).length).toBe(0);
  });
});
