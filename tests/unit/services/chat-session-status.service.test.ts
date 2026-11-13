import { describe, it, expect } from "bun:test";
import {
  listChatSessionStatus, type ChatSessionStatusDeps, type LiveSessionState, type SessionMetaRow,
} from "../../../src/services/chat-session-status.service.ts";
import type { TraceTurnStatus } from "../../../src/services/session-trace/turn-stop-reader.ts";

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const H = 3_600_000;

interface Fixture {
  traces?: Array<{ traceId: string; updatedAt: number; providerId?: string | null }>;
  status?: Record<string, TraceTurnStatus>;
  migrated?: Record<string, string>;
  meta?: SessionMetaRow[];
  projects?: string[];
  live?: Record<string, LiveSessionState>;
  running?: string[];
}

function deps(f: Fixture): ChatSessionStatusDeps & { since: number[] } {
  const since: number[] = [];
  return {
    since,
    now: () => NOW,
    recentTraces: (s) => { since.push(s); return (f.traces ?? []).map((t) => ({ providerId: null, ...t })); },
    turnStatus: (id) => f.status?.[id] ?? { last: null, lastAnswerAt: null, lastUserMessageAt: null },
    currentSessionId: (id) => f.migrated?.[id] ?? id,
    metadata: (ids) => new Map((f.meta ?? []).filter((m) => ids.includes(m.sessionId)).map((m) => [m.sessionId, m])),
    registeredProjects: () => new Set(f.projects ?? ["ppm"]),
    liveState: () => new Map(Object.entries(f.live ?? {})),
    isTurnRunning: (id) => (f.running ?? []).includes(id),
  };
}

const meta = (sessionId: string, over: Partial<SessionMetaRow> = {}): SessionMetaRow =>
  ({ sessionId, projectName: "ppm", providerId: "claude", unreadType: null, title: `Title ${sessionId}`, ...over });

describe("listChatSessionStatus", () => {
  it("asks the trace for the window and reports a finished, unanswered session", () => {
    const d = deps({
      traces: [{ traceId: "s1", updatedAt: NOW - 2 * H }],
      status: { s1: { last: { outcome: "done", at: NOW - 2 * H }, lastAnswerAt: NOW - 2 * H, lastUserMessageAt: NOW - 3 * H } },
      meta: [meta("s1", { unreadType: "done" })],
    });
    const out = listChatSessionStatus(d, { sinceHours: 336 });
    expect(d.since).toEqual([NOW - 336 * H]);
    expect(out.generatedAt).toBe("2026-10-26T12:00:00.000Z");
    expect(out.sessions).toEqual([{
      sessionId: "s1", providerId: "claude", projectName: "ppm", title: "Title s1",
      updatedAt: new Date(NOW - 2 * H).toISOString(), phase: "idle", pending: null,
      lastTurn: { outcome: "done", at: new Date(NOW - 2 * H).toISOString() },
      lastAnswerAt: new Date(NOW - 2 * H).toISOString(), lastUserMessageAt: new Date(NOW - 3 * H).toISOString(),
      userRepliedSinceAnswer: false, unreadType: "done",
    }]);
  });

  it("reports a pending question from the live entry, and running while not idle", () => {
    const out = listChatSessionStatus(deps({
      traces: [{ traceId: "s1", updatedAt: NOW - 1000 }],
      meta: [meta("s1")],
      live: { s1: { phase: "streaming", providerId: "codex", pending: { tool: "AskUserQuestion", requestId: "r-9", since: NOW - 500 } } },
    }), { sinceHours: 1 });
    const s = out.sessions[0]!;
    expect(s.phase).toBe("streaming");
    expect(s.pending).toEqual({ kind: "question", tool: "AskUserQuestion", requestId: "r-9", since: new Date(NOW - 500).toISOString() });
    expect(s.lastTurn?.outcome).toBe("running");
  });

  it("calls any other pending tool an approval", () => {
    const out = listChatSessionStatus(deps({
      traces: [{ traceId: "s1", updatedAt: NOW }], meta: [meta("s1")],
      live: { s1: { phase: "idle", providerId: "claude", pending: { tool: "Bash", requestId: "r1", since: NOW } } },
    }), { sinceHours: 1 });
    expect(out.sessions[0]!.pending?.kind).toBe("approval");
  });

  it("maps cancelled, max turns and a run that died mid-turn", () => {
    const dead = NOW - 10 * 60_000;
    const out = listChatSessionStatus(deps({
      traces: [{ traceId: "a", updatedAt: NOW - 3 }, { traceId: "b", updatedAt: NOW - 2 }, { traceId: "c", updatedAt: dead }],
      status: {
        a: { last: { outcome: "cancelled", at: NOW - 3 }, lastAnswerAt: null, lastUserMessageAt: NOW - 4 },
        b: { last: { outcome: "max_turns", at: NOW - 2, message: "limit", subtype: "error_max_turns" }, lastAnswerAt: NOW - 2, lastUserMessageAt: NOW - 9 },
        c: { last: { outcome: "unfinished", at: dead }, lastAnswerAt: null, lastUserMessageAt: dead - 5 },
      },
      meta: [meta("a"), meta("b"), meta("c")],
    }), { sinceHours: 1 });
    const byId = Object.fromEntries(out.sessions.map((s) => [s.sessionId, s.lastTurn]));
    expect(byId.a).toEqual({ outcome: "cancelled", at: new Date(NOW - 3).toISOString() });
    expect(byId.b).toEqual({ outcome: "max_turns", at: new Date(NOW - 2).toISOString(), message: "limit", subtype: "error_max_turns" });
    expect(byId.c).toEqual({ outcome: "error", at: new Date(dead).toISOString(), message: "The turn ended without finishing" });
    expect(out.sessions.map((s) => s.sessionId)).toEqual(["b", "a", "c"]);
  });

  it("calls a turn running when this process runs it without a chat socket (scheduler, Jira, a bot)", () => {
    const out = listChatSessionStatus(deps({
      traces: [{ traceId: "sched", updatedAt: NOW - 10 * 60_000 }],
      status: { sched: { last: { outcome: "unfinished", at: NOW - 10 * 60_000 }, lastAnswerAt: null, lastUserMessageAt: NOW - 11 * 60_000 } },
      meta: [meta("sched")],
      running: ["sched"],
    }), { sinceHours: 1 });
    expect(out.sessions[0]).toMatchObject({ phase: "idle", lastTurn: { outcome: "running" } });
  });

  it("gives a turn another process is writing (ppm chat) two minutes before calling it dead", () => {
    const out = listChatSessionStatus(deps({
      traces: [{ traceId: "cli", updatedAt: NOW - 30_000 }],
      status: { cli: { last: { outcome: "unfinished", at: NOW - 30_000 }, lastAnswerAt: null, lastUserMessageAt: NOW - 40_000 } },
      meta: [meta("cli")],
    }), { sinceHours: 1 });
    expect(out.sessions[0]!.lastTurn).toEqual({ outcome: "running", at: new Date(NOW - 30_000).toISOString() });
  });

  it("says the user replied when their message is newer than the answer", () => {
    const out = listChatSessionStatus(deps({
      traces: [{ traceId: "s1", updatedAt: NOW }], meta: [meta("s1")],
      status: { s1: { last: { outcome: "done", at: NOW - 10 }, lastAnswerAt: NOW - 10, lastUserMessageAt: NOW - 5 } },
    }), { sinceHours: 1 });
    expect(out.sessions[0]!.userRepliedSinceAnswer).toBe(true);
  });

  it("reports a migrated session under its current id, with metadata from either id", () => {
    const out = listChatSessionStatus(deps({
      traces: [{ traceId: "old", updatedAt: NOW, providerId: "codex" }],
      migrated: { old: "new" },
      meta: [meta("old", { title: "Kept title", providerId: null }), meta("new", { title: null, providerId: null, projectName: null })],
    }), { sinceHours: 1 });
    expect(out.sessions).toHaveLength(1);
    expect(out.sessions[0]).toMatchObject({ sessionId: "new", projectName: "ppm", title: "Kept title", providerId: "codex" });
  });

  it("leaves out sessions with no metadata, an unregistered project, or another project when filtered", () => {
    const d = deps({
      traces: [{ traceId: "ghost", updatedAt: NOW }, { traceId: "gone", updatedAt: NOW }, { traceId: "mine", updatedAt: NOW }, { traceId: "other", updatedAt: NOW }],
      meta: [meta("gone", { projectName: "deleted" }), meta("mine"), meta("other", { projectName: "web" })],
      projects: ["ppm", "web"],
    });
    expect(listChatSessionStatus(d, { sinceHours: 1 }).sessions.map((s) => s.sessionId).sort()).toEqual(["mine", "other"]);
    expect(listChatSessionStatus(d, { sinceHours: 1, project: "web" }).sessions.map((s) => s.sessionId)).toEqual(["other"]);
  });
});
