import { describe, it, expect, beforeEach } from "bun:test";
import { openTestDb, setDb } from "../../src/services/db.service.ts";
import { groupChatRoutes } from "../../src/server/routes/group-chat.ts";
import { groupChatService } from "../../src/services/group-chat/group-chat.service.ts";
import type { GroupMember, AgentTurnResult } from "../../src/types/group-chat.ts";

// Scripted deterministic runner: leader kicks off then finalizes; member replies.
function scriptedRunAgent(): (m: GroupMember, prompt: string) => Promise<AgentTurnResult> {
  const queues: Record<string, string[]> = {
    lead: ["Let's begin @alice.", "DONE: single table. simpler."],
    alice: ["Agreed @lead."],
  };
  return async (m) => ({ text: queues[m.name]?.shift() ?? "(silence)", usage: { costUsd: 0 } });
}

async function waitForDone(groupId: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!groupChatService.isRunning(groupId)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

const json = (path: string, method: string, body?: unknown) =>
  groupChatRoutes.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

describe("group-chat REST + engine integration", () => {
  beforeEach(() => {
    setDb(openTestDb());
    groupChatService._setRunAgentFactory(scriptedRunAgent);
    groupChatService._setSpawnStub(true);
  });

  it("creates a group with members and lists it project-scoped", async () => {
    const res = await json("/", "POST", {
      projectName: "demo", projectPath: "/p/demo", name: "Team A",
      members: [
        { role: "leader", name: "lead" },
        { role: "member", name: "alice" },
      ],
    });
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: { id: string } };
    expect(data.id).toBeTruthy();

    const list = await (await json("/?projectPath=/p/demo", "GET")).json() as { data: unknown[] };
    expect(list.data.length).toBe(1);

    const empty = await (await json("/?projectPath=/p/other", "GET")).json() as { data: unknown[] };
    expect(empty.data.length).toBe(0);
  });

  it("send message runs the engine; feed returns the converged transcript", async () => {
    const created = await (await json("/", "POST", {
      projectName: "demo", projectPath: "/p/demo", name: "T",
      members: [{ role: "leader", name: "lead" }, { role: "member", name: "alice" }],
    })).json() as { data: { id: string } };
    const gid = created.data.id;

    const sendRes = await json(`/${gid}/message`, "POST", { content: "how to store the bus?" });
    expect(sendRes.status).toBe(200);

    await waitForDone(gid);

    const feed = await (await json(`/${gid}/feed`, "GET")).json() as { data: { messages: Array<{ kind: string; fromMember: string; summary: string }> } };
    expect(feed.data.messages.length).toBeGreaterThan(0);
    const finals = feed.data.messages.filter((m) => m.kind === "final");
    expect(finals.length).toBe(1);
    expect(finals[0].fromMember).toBe("lead");
  });

  it("stop pauses; resume re-runs the loop off the durable bus", async () => {
    const created = await (await json("/", "POST", {
      projectName: "demo", projectPath: "/p/demo", name: "T",
      members: [{ role: "leader", name: "lead" }],
    })).json() as { data: { id: string } };
    const gid = created.data.id;

    // Seed the bus with a task so resume has something to re-enter from.
    await json(`/${gid}/message`, "POST", { content: "task" });
    await waitForDone(gid);

    const stopRes = await json(`/${gid}/stop`, "POST");
    expect(stopRes.status).toBe(200);
    let detail = await (await json(`/${gid}`, "GET")).json() as { data: { status: string } };
    expect(detail.data.status).toBe("paused");

    // Resume re-enters the loop; status leaves "paused" (active while running,
    // then idle on convergence) — never stuck paused.
    const resumeRes = await json(`/${gid}/resume`, "POST");
    expect(resumeRes.status).toBe(200);
    await waitForDone(gid);
    detail = await (await json(`/${gid}`, "GET")).json() as { data: { status: string } };
    expect(detail.data.status).not.toBe("paused");
  });

  it("rejects an invalid group id", async () => {
    const res = await json("/bad id!/feed", "GET");
    expect(res.status).toBe(400);
  });

  it("transcript route returns 404 when nothing archived, 400 for bad ref", async () => {
    const created = await (await json("/", "POST", {
      projectName: "demo", projectPath: "/p/demo", name: "T",
      members: [{ role: "leader", name: "lead" }],
    })).json() as { data: { id: string } };
    const gid = created.data.id;

    const missing = await json(`/${gid}/transcript?sessionRef=abc-123`, "GET");
    expect(missing.status).toBe(404);

    const badRef = await json(`/${gid}/transcript?sessionRef=bad ref!`, "GET");
    expect(badRef.status).toBe(400);
  });

  it("deletes a group", async () => {
    const created = await (await json("/", "POST", {
      projectName: "demo", projectPath: "/p/demo", name: "T",
      members: [{ role: "leader", name: "lead" }],
    })).json() as { data: { id: string } };
    const gid = created.data.id;
    const del = await json(`/${gid}`, "DELETE");
    expect(del.status).toBe(200);
    const detail = await json(`/${gid}`, "GET");
    expect(detail.status).toBe(404);
  });
});
