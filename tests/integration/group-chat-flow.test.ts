import { describe, it, expect, beforeEach } from "bun:test";
import { openTestDb, setDb } from "../../src/services/db.service.ts";
import { groupChatService } from "../../src/services/group-chat/group-chat.service.ts";
import { createGroup, addMember, readMessages, getGroup, appendMessage } from "../../src/services/group-chat/group-chat.store.ts";
import type { GroupMember, AgentTurnResult } from "../../src/types/group-chat.ts";

function makeGroup() {
  const g = createGroup({ projectName: "demo", projectPath: "/p/demo", name: "flow", maxTurns: 40 });
  addMember({ groupId: g.id, role: "leader", name: "lead" });
  addMember({ groupId: g.id, role: "member", name: "alice" });
  return g;
}

function replies(groupId: string) {
  return readMessages(groupId).filter((m) => m.fromMember !== "user");
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("group-chat conversational flow", () => {
  beforeEach(() => {
    setDb(openTestDb());
    groupChatService._setSpawnStub(true);
    groupChatService._setBackend(null); // clears fake backend + alive-sessions between tests
    groupChatService._setResponderRouterFactory(null); // default: legacy mention path
  });

  it("user message → leader replies once (no mention) → chat message, idle, no final", async () => {
    groupChatService._setRunAgentFactory(() => {
      return async (m: GroupMember) => ({
        text: m.name === "lead" ? "Chào bạn, cần gì không?" : "(silence)",
        usage: { costUsd: 0 },
      });
    });
    const g = makeGroup();
    await groupChatService.start(g.id, "Hú");
    await waitFor(() => !groupChatService.isRunning(g.id));

    const msgs = readMessages(g.id);
    expect(msgs.some((m) => m.kind === "chat" && m.fromMember === "user")).toBe(true);
    expect(msgs.some((m) => m.kind === "task")).toBe(false);
    expect(msgs.some((m) => m.kind === "final")).toBe(false);
    expect(replies(g.id).length).toBe(1);
    expect(replies(g.id)[0].fromMember).toBe("lead");
    expect(getGroup(g.id)?.status).toBe("idle");
  });

  it("@mentioned member replies to the user", async () => {
    groupChatService._setRunAgentFactory(() => {
      return async (m: GroupMember) => ({
        text: m.name === "alice" ? "Mình thấy ổn đó." : "(silence)",
        usage: { costUsd: 0 },
      });
    });
    const g = makeGroup();
    await groupChatService.start(g.id, "@alice bạn nghĩ sao?");
    await waitFor(() => !groupChatService.isRunning(g.id));

    expect(replies(g.id).map((m) => m.fromMember)).toEqual(["alice"]);
    expect(getGroup(g.id)?.status).toBe("idle");
  });

  it("Stop halts a running burst mid-flight and sets paused", async () => {
    let turns = 0;
    // Members keep @pulling each other; each turn blocks so we can stop mid-flight.
    groupChatService._setRunAgentFactory(() => {
      return async (m: GroupMember): Promise<AgentTurnResult> => {
        turns++;
        await new Promise((r) => setTimeout(r, 20));
        const other = m.name === "lead" ? "alice" : "lead";
        return { text: `nói tiếp @${other}`, usage: { costUsd: 0 } };
      };
    });
    const g = makeGroup();
    void groupChatService.start(g.id, "@lead bắt đầu đi");
    await waitFor(() => turns >= 1, 1000);
    groupChatService.stop(g.id);

    await waitFor(() => !groupChatService.isRunning(g.id));
    const turnsAtStop = turns;
    expect(getGroup(g.id)?.status).toBe("paused");
    await new Promise((r) => setTimeout(r, 60));
    expect(turns).toBeLessThanOrEqual(turnsAtStop + 1);
  });

  it("queues a message sent while a burst is running, then answers it", async () => {
    groupChatService._setRunAgentFactory(() => {
      return async (m: GroupMember): Promise<AgentTurnResult> => {
        await new Promise((r) => setTimeout(r, 25));
        return { text: m.name === "lead" ? "ừ nghe rồi" : "(silence)", usage: { costUsd: 0 } };
      };
    });
    const g = makeGroup();
    void groupChatService.start(g.id, "tin nhắn 1");
    // While the first burst is running, send a second message → must queue.
    await waitFor(() => groupChatService.isRunning(g.id), 500);
    await groupChatService.start(g.id, "tin nhắn 2");

    // Both user messages persisted; both bursts eventually run.
    await waitFor(() => replies(g.id).length >= 2 && !groupChatService.isRunning(g.id));
    const userMsgs = readMessages(g.id).filter((m) => m.fromMember === "user");
    expect(userMsgs.map((m) => m.summary)).toEqual(["tin nhắn 1", "tin nhắn 2"]);
    expect(replies(g.id).length).toBeGreaterThanOrEqual(2);
    expect(getGroup(g.id)?.status).toBe("idle");
  });

  it("a persistent WS client receives messages across consecutive bursts (no orphaning)", async () => {
    groupChatService._setRunAgentFactory(() => {
      return async (m: GroupMember) => ({
        text: m.name === "lead" ? "ok" : "(silence)",
        usage: { costUsd: 0 },
      });
    });
    const g = makeGroup();
    const received: Array<{ type: string; message?: { fromMember: string; summary: string | null } }> = [];
    const ws = { send: (d: string) => received.push(JSON.parse(d)) };
    groupChatService.addClient(g.id, ws);

    await groupChatService.start(g.id, "một");
    await waitFor(() => !groupChatService.isRunning(g.id));
    // Second burst after the first fully ended (runtime was created + destroyed once).
    await groupChatService.start(g.id, "hai");
    await waitFor(() => !groupChatService.isRunning(g.id));

    const userMsgs = received
      .filter((e) => e.type === "group_message" && e.message?.fromMember === "user")
      .map((e) => e.message!.summary);
    // BOTH must arrive live — before the fix, "hai" was lost (client orphaned after burst 1).
    expect(userMsgs).toEqual(["một", "hai"]);
    groupChatService.removeClient(g.id, ws);
  });

  it("back-to-back messages queue (runtime registered synchronously, no double burst)", async () => {
    groupChatService._setRunAgentFactory(() => {
      return async (m: GroupMember) => ({
        text: m.name === "lead" ? "ok" : "(silence)",
        usage: { costUsd: 0 },
      });
    });
    const g = makeGroup();
    // Two sends with no await between → the 2nd must queue behind the 1st burst.
    void groupChatService.start(g.id, "một");
    void groupChatService.start(g.id, "hai");

    await waitFor(() =>
      readMessages(g.id).filter((m) => m.fromMember === "user").length === 2 &&
      replies(g.id).length >= 2 &&
      !groupChatService.isRunning(g.id));
    const userMsgs = readMessages(g.id).filter((m) => m.fromMember === "user").map((m) => m.summary);
    expect(userMsgs).toEqual(["một", "hai"]);
    expect(getGroup(g.id)?.status).toBe("idle");
  });

  it("keep-alive: member sessions are created once and reused across bursts", async () => {
    let createCount = 0;
    groupChatService._setSpawnStub(false);
    groupChatService._setBackend({
      async createSession() { createCount++; return { id: `s${createCount}` }; },
      async *sendMessage() { yield { type: "done" }; },
    });
    groupChatService._setRunAgentFactory(() => async (m: GroupMember) => ({
      text: m.name === "lead" ? "ok" : "(silence)", usage: { costUsd: 0 },
    }));
    groupChatService._setResponderRouterFactory(() => async () => []); // leader fallback; no router session

    const g = makeGroup(); // lead + alice
    await groupChatService.start(g.id, "một");
    await waitFor(() => !groupChatService.isRunning(g.id));
    await groupChatService.start(g.id, "hai");
    await waitFor(() => !groupChatService.isRunning(g.id));

    // 2 members created ONCE each — reused (not archived+recreated) on the 2nd burst.
    expect(createCount).toBe(2);

    // Teardown archives without throwing; restore stub mode for other tests.
    await groupChatService.archiveAndForget(g.id);
    groupChatService._setBackend(null);
    groupChatService._setSpawnStub(true);
  });

  it("router (no mention) selects a member without requiring a tag", async () => {
    groupChatService._setRunAgentFactory(() => {
      return async (m: GroupMember) => ({ text: m.name === "alice" ? "mình lo phần này" : "(silence)", usage: { costUsd: 0 } });
    });
    // Router picks alice on the user turn, then ends.
    groupChatService._setResponderRouterFactory(() => {
      const seq: string[][] = [["alice"], []];
      let i = 0;
      return async () => (i < seq.length ? seq[i++]! : []);
    });
    const g = makeGroup();
    await groupChatService.start(g.id, "ai lo backend?");
    await waitFor(() => !groupChatService.isRunning(g.id));
    expect(replies(g.id).map((m) => m.fromMember)).toEqual(["alice"]);
    expect(getGroup(g.id)?.status).toBe("idle");
  });

  it("router null on the user turn still yields ≥1 (leader fallback)", async () => {
    groupChatService._setRunAgentFactory(() => {
      return async (m: GroupMember) => ({ text: m.name === "lead" ? "để mình" : "(silence)", usage: { costUsd: 0 } });
    });
    groupChatService._setResponderRouterFactory(() => async () => []);
    const g = makeGroup();
    await groupChatService.start(g.id, "câu chung");
    await waitFor(() => !groupChatService.isRunning(g.id));
    expect(replies(g.id).map((m) => m.fromMember)).toEqual(["lead"]);
    expect(getGroup(g.id)?.status).toBe("idle");
  });

  it("Resume is a no-op after a natural end (no duplicate replies)", async () => {
    groupChatService._setRunAgentFactory(() => {
      return async (m: GroupMember) => ({
        text: m.name === "lead" ? "trả lời xong" : "(silence)",
        usage: { costUsd: 0 },
      });
    });
    const g = makeGroup();
    await groupChatService.start(g.id, "câu hỏi");
    await waitFor(() => !groupChatService.isRunning(g.id));
    const afterFirst = replies(g.id).length;
    expect(afterFirst).toBeGreaterThan(0);

    // Last message is an assistant reply → conversation already answered → no-op.
    await groupChatService.resume(g.id);
    await waitFor(() => !groupChatService.isRunning(g.id));
    expect(replies(g.id).length).toBe(afterFirst);
    expect(getGroup(g.id)?.status).toBe("idle");
  });

  it("Resume answers a trailing unanswered user message (e.g. after a Stop)", async () => {
    groupChatService._setRunAgentFactory(() => {
      return async (m: GroupMember) => ({
        text: m.name === "lead" ? "giờ mới trả lời" : "(silence)",
        usage: { costUsd: 0 },
      });
    });
    const g = makeGroup();
    // Simulate a user message left unanswered (a burst stopped before replying).
    appendMessage({ groupId: g.id, fromMember: "user", kind: "chat", summary: "chưa trả lời", turnIndex: 0 });

    await groupChatService.resume(g.id);
    await waitFor(() => !groupChatService.isRunning(g.id));
    expect(replies(g.id).length).toBeGreaterThan(0);
    expect(getGroup(g.id)?.status).toBe("idle");
  });
});
