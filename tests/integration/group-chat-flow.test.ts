import { describe, it, expect, beforeEach } from "bun:test";
import { openTestDb, setDb } from "../../src/services/db.service.ts";
import { groupChatService } from "../../src/services/group-chat/group-chat.service.ts";
import { createGroup, addMember, readMessages, getGroup } from "../../src/services/group-chat/group-chat.store.ts";
import type { GroupMember, AgentTurnResult } from "../../src/types/group-chat.ts";

function makeGroup() {
  const g = createGroup({ projectName: "demo", projectPath: "/p/demo", name: "flow", maxTurns: 40 });
  addMember({ groupId: g.id, role: "leader", name: "lead" });
  addMember({ groupId: g.id, role: "member", name: "alice" });
  return g;
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("group-chat full flow (stop / resume)", () => {
  beforeEach(() => {
    setDb(openTestDb());
    groupChatService._setSpawnStub(true);
  });

  it("runs create -> discuss -> leader DONE and persists exactly one final", async () => {
    groupChatService._setRunAgentFactory(() => {
      const q: Record<string, string[]> = {
        lead: ["kickoff @alice", "DONE: single table"],
        alice: ["agree @lead"],
      };
      return async (m) => ({ text: q[m.name]?.shift() ?? "(silence)", usage: { costUsd: 0 } });
    });
    const g = makeGroup();
    await groupChatService.start(g.id, "how to store the bus?");
    await waitFor(() => !groupChatService.isRunning(g.id));

    const msgs = readMessages(g.id);
    expect(msgs.some((m) => m.kind === "task" && m.fromMember === "user")).toBe(true);
    expect(msgs.filter((m) => m.kind === "final").length).toBe(1);
    expect(getGroup(g.id)?.status).toBe("idle");
  });

  it("Stop halts the loop mid-discussion (no runaway) and sets paused", async () => {
    let turns = 0;
    // Never emits DONE; each turn blocks briefly so we can stop mid-flight.
    groupChatService._setRunAgentFactory(() => {
      return async (m: GroupMember): Promise<AgentTurnResult> => {
        turns++;
        await new Promise((r) => setTimeout(r, 20));
        return { text: `talk ${turns} @alice`, usage: { costUsd: 0 } };
      };
    });
    const g = makeGroup();
    void groupChatService.start(g.id, "discuss forever");
    // Let a couple of turns run, then stop.
    await waitFor(() => turns >= 2, 1000);
    groupChatService.stop(g.id);

    await waitFor(() => !groupChatService.isRunning(g.id));
    const turnsAtStop = turns;
    expect(getGroup(g.id)?.status).toBe("paused");
    // No runaway: at most one more turn after stop signal (cooperative cancel).
    await new Promise((r) => setTimeout(r, 60));
    expect(turns).toBeLessThanOrEqual(turnsAtStop + 1);
  });

  it("Resume re-spawns and continues from the durable bus, appending a new round", async () => {
    // First round converges quickly.
    groupChatService._setRunAgentFactory(() => {
      const q: Record<string, string[]> = { lead: ["DONE: round one done"] };
      return async (m) => ({ text: q[m.name]?.shift() ?? "(silence)", usage: { costUsd: 0 } });
    });
    const g = makeGroup();
    await groupChatService.start(g.id, "first task");
    await waitFor(() => !groupChatService.isRunning(g.id));
    const afterFirst = readMessages(g.id).length;
    expect(afterFirst).toBeGreaterThan(0);

    // Resume: second round should append more messages to the SAME bus.
    groupChatService._setRunAgentFactory(() => {
      const q: Record<string, string[]> = { lead: ["DONE: round two done"] };
      return async (m) => ({ text: q[m.name]?.shift() ?? "(silence)", usage: { costUsd: 0 } });
    });
    await groupChatService.resume(g.id);
    await waitFor(() => !groupChatService.isRunning(g.id));

    const afterResume = readMessages(g.id);
    expect(afterResume.length).toBeGreaterThan(afterFirst);
    // Two finals total (one per round), same durable bus.
    expect(afterResume.filter((m) => m.kind === "final").length).toBe(2);
    expect(getGroup(g.id)?.status).toBe("idle");
  });
});
