import { describe, it, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openTestDb, setDb } from "../../src/services/db.service.ts";
import { groupChatRoutes } from "../../src/server/routes/group-chat.ts";
import { groupChatService } from "../../src/services/group-chat/group-chat.service.ts";
import type { GroupMember, AgentTurnResult } from "../../src/types/group-chat.ts";

// Scripted deterministic runner: leader replies conversationally to the user (no @mention
// → the burst ends after one turn).
function scriptedRunAgent(): (m: GroupMember, prompt: string) => Promise<AgentTurnResult> {
  return async (m) => ({
    text: m.name === "lead" ? "Chào bạn, mình đây." : "(silence)",
    usage: { costUsd: 0 },
  });
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
    groupChatService._setResponderRouterFactory(null);
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

  it("send message runs a reply burst; feed returns user + assistant chat, no final", async () => {
    const created = await (await json("/", "POST", {
      projectName: "demo", projectPath: "/p/demo", name: "T",
      members: [{ role: "leader", name: "lead" }, { role: "member", name: "alice" }],
    })).json() as { data: { id: string } };
    const gid = created.data.id;

    const sendRes = await json(`/${gid}/message`, "POST", { content: "how to store the bus?" });
    expect(sendRes.status).toBe(200);

    await waitForDone(gid);

    const feed = await (await json(`/${gid}/feed`, "GET")).json() as { data: { messages: Array<{ kind: string; fromMember: string; summary: string }> } };
    expect(feed.data.messages.some((m) => m.kind === "chat" && m.fromMember === "user")).toBe(true);
    expect(feed.data.messages.some((m) => m.kind === "final")).toBe(false);
    const assistant = feed.data.messages.filter((m) => m.fromMember !== "user");
    expect(assistant.length).toBe(1);
    expect(assistant[0].fromMember).toBe("lead");
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

  it("adds, updates, promotes, and removes members with invariants", async () => {
    const created = await (await json("/", "POST", {
      projectName: "demo", projectPath: "/p/demo", name: "T",
      members: [{ role: "leader", name: "lead" }, { role: "member", name: "alice" }],
    })).json() as { data: { id: string } };
    const gid = created.data.id;

    // Add a member.
    const added = await (await json(`/${gid}/members`, "POST", { name: "bob", persona: "qa", model: "sonnet" })).json() as { data: { id: string; role: string } };
    expect(added.data.role).toBe("member");

    // Update its fields.
    const upd = await (await json(`/${gid}/members/${added.data.id}`, "PATCH", { name: "bob2", persona: "devops" })).json() as { data: { name: string; persona: string } };
    expect(upd.data.name).toBe("bob2");
    expect(upd.data.persona).toBe("devops");

    // Promote bob to leader → the old leader is demoted (exactly one leader).
    await json(`/${gid}/members/${added.data.id}`, "PATCH", { role: "leader" });
    const detail = await (await json(`/${gid}`, "GET")).json() as { data: { members: Array<{ name: string; role: string }> } };
    const leaders = detail.data.members.filter((m) => m.role === "leader");
    expect(leaders.length).toBe(1);
    expect(leaders[0].name).toBe("bob2");

    // Removing the (new) leader is rejected.
    const delLeader = await json(`/${gid}/members/${added.data.id}`, "DELETE");
    expect(delLeader.status).toBe(400);

    // Removing a non-leader member works.
    const members = detail.data.members;
    const nonLeader = (await (await json(`/${gid}`, "GET")).json() as { data: { members: Array<{ id: string; role: string }> } })
      .data.members.find((m) => m.role !== "leader")!;
    const delOk = await json(`/${gid}/members/${nonLeader.id}`, "DELETE");
    expect(delOk.status).toBe(200);
    expect(members.length).toBeGreaterThan(0);
  });

  it("transcript resolves a LIVE (unarchived) session file and returns parsed messages", async () => {
    const created = await (await json("/", "POST", {
      projectName: "demo", projectPath: "/p/demo", name: "T",
      members: [{ role: "leader", name: "lead" }],
    })).json() as { data: { id: string } };
    const gid = created.data.id;

    // Seed a live Claude session JSONL under a temp CLAUDE_PROJECTS_DIR root.
    const root = join(tmpdir(), `ppm-live-${Date.now()}`);
    const sessionId = "11111111-2222-3333-4444-555555555555";
    mkdirSync(join(root, "proj"), { recursive: true });
    const jsonl = [
      JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-07-28T00:00:00Z", cwd: "/p/demo", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
      JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-07-28T00:00:01Z", message: { role: "assistant", model: "claude-haiku-4-5", content: [{ type: "text", text: "hello there" }] } }),
    ].join("\n");
    writeFileSync(join(root, "proj", `${sessionId}.jsonl`), jsonl);
    const prev = process.env.CLAUDE_PROJECTS_DIR;
    process.env.CLAUDE_PROJECTS_DIR = root;
    try {
      const res = await json(`/${gid}/transcript?sessionRef=${sessionId}`, "GET");
      expect(res.status).toBe(200);
      const body = await res.json() as { data: { messages: Array<{ role: string; content: string }>; config: { model?: string } | null } };
      expect(body.data.messages.length).toBeGreaterThan(0);
      expect(body.data.messages.some((m) => m.content.includes("hello there"))).toBe(true);
      expect(body.data.config?.model).toBe("claude-haiku-4-5");
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PROJECTS_DIR; else process.env.CLAUDE_PROJECTS_DIR = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("updates the per-group reply cap (maxTurns) and validates range", async () => {
    const created = await (await json("/", "POST", {
      projectName: "demo", projectPath: "/p/demo", name: "T", maxTurns: 10,
      members: [{ role: "leader", name: "lead" }],
    })).json() as { data: { id: string } };
    const gid = created.data.id;

    const ok1 = await json(`/${gid}`, "PATCH", { maxTurns: 6 });
    expect(ok1.status).toBe(200);
    const detail = await (await json(`/${gid}`, "GET")).json() as { data: { maxTurns: number } };
    expect(detail.data.maxTurns).toBe(6);

    expect((await json(`/${gid}`, "PATCH", { maxTurns: 0 })).status).toBe(400);
    expect((await json(`/${gid}`, "PATCH", { maxTurns: 999 })).status).toBe(400);
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
