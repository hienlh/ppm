/**
 * The turn window: the turns around one, read from the turn index, for a jump to a turn the chat
 * has not loaded. It must span compactions, refuse a turn a rollback removed, and stay inside its
 * caps however long the turns around the target are.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { _setClaudeProjectsRoot } from "../../../src/services/agent-transcript/claude-projects-root.ts";
import { _setCodexSessionsDirsForTest } from "../../../src/services/agent-transcript/session-ownership.ts";
import {
  chatTurnWindowRoutes, parseTurnWindowQuery, pickWindowTurns, TURN_WINDOW_MAX_MESSAGES, TURN_WINDOW_MAX_TURNS,
} from "../../../src/server/routes/chat-turn-window.ts";
import type { SessionTurnSummary } from "../../../src/services/session-turns/session-turn-types.ts";
import type { ChatMessage } from "../../../src/types/chat.ts";
import { claude, codex, lines } from "../services/session-turn-fixtures.ts";

const root = mkdtempSync(join(tmpdir(), "ppm-turn-window-"));
const projectPath = join(root, "proj");
const slugDir = join(root, "projects", projectPath.replace(/[/\\:.]/g, "-"));
const sessionsDir = join(root, "sessions");

const app = new Hono<{ Variables: { projectPath: string; projectName: string } }>();
app.use("*", async (c, next) => { c.set("projectPath", projectPath); c.set("projectName", "p"); await next(); });
app.route("/chat", chatTurnWindowRoutes);

// A rollout is only trusted inside a Codex sessions root, which `CODEX_HOME` names.
const savedCodexHome = process.env.CODEX_HOME;
beforeAll(() => {
  process.env.CODEX_HOME = root;
  mkdirSync(slugDir, { recursive: true });
  _setClaudeProjectsRoot(join(root, "projects"));
  _setCodexSessionsDirsForTest(() => [sessionsDir]);
});
afterAll(() => {
  _setClaudeProjectsRoot(null);
  _setCodexSessionsDirsForTest(null);
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  rmSync(root, { recursive: true, force: true });
});

const P = (n: number) => `66666666-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Twelve turns, with a compaction inside turn 6: turns 1–5 lie before it. */
function writeClaudeSession(): string {
  const id = randomUUID();
  const records: string[] = [];
  for (let n = 1; n <= 12; n++) {
    records.push(claude.prompt(`ask ${n}`, P(n)), claude.assistant(`answer ${n}`));
    if (n === 6) records.push(claude.compactBoundary(), claude.compactSummary(P(6)), claude.assistant("after compaction"));
  }
  writeFileSync(join(slugDir, `${id}.jsonl`), lines(...records));
  return id;
}

async function get(id: string, query: string, providerId = "claude"): Promise<{ status: number; body: any }> {
  const res = await app.request(`/chat/sessions/${id}/turn-window?providerId=${providerId}&${query}`);
  return { status: res.status, body: await res.json() };
}

const turnNs = (body: any) => body.data.turns.map((t: { n: number }) => t.n);
const prompts = (body: any) => (body.data.messages as ChatMessage[]).filter((m) => m.role === "user").map((m) => m.content);

describe("turn window route", () => {
  test("a turn in the middle comes with two turns before and three after, stamped", async () => {
    const id = writeClaudeSession();
    const { status, body } = await get(id, `turn=${P(8)}`);
    expect(status).toBe(200);
    expect(turnNs(body)).toEqual([6, 7, 8, 9, 10, 11]);
    expect(body.data.hasOlder).toBe(true);
    expect(body.data.hasNewer).toBe(true);
    expect(body.data.latestTurnId).toBe(P(12));
    const stamped = (body.data.messages as ChatMessage[]).filter((m) => !m.synthetic);
    expect(stamped.every((m) => typeof m.turnId === "string" && typeof m.turnN === "number")).toBe(true);
    expect(stamped.find((m) => m.content === "ask 8")!.turnN).toBe(8);
  });

  test("a turn at the start, before the compaction, keeps its number from the session start", async () => {
    const id = writeClaudeSession();
    const { body } = await get(id, `turn=${P(1)}`);
    expect(turnNs(body)).toEqual([1, 2, 3, 4]);
    expect(body.data.hasOlder).toBe(false);
    expect(prompts(body)).toEqual(["ask 1", "ask 2", "ask 3", "ask 4"]);
  });

  test("a turn at the end has nothing newer", async () => {
    const id = writeClaudeSession();
    const { body } = await get(id, `turn=${P(12)}&before=1&after=3`);
    expect(turnNs(body)).toEqual([11, 12]);
    expect(body.data.hasNewer).toBe(false);
  });

  test("the turn holding a compaction shows it as one marker, not the summary", async () => {
    const id = writeClaudeSession();
    const { body } = await get(id, `turn=${P(6)}&before=0&after=0`);
    const messages = body.data.messages as ChatMessage[];
    expect(messages.filter((m) => m.synthetic).length).toBe(1);
    expect(messages.some((m) => m.content.includes("being continued"))).toBe(false);
  });

  test("pages after and before a turn walk the session both ways", async () => {
    const id = writeClaudeSession();
    expect(turnNs((await get(id, `afterTurn=${P(10)}`)).body)).toEqual([11, 12]);
    expect(turnNs((await get(id, `afterTurn=${P(12)}`)).body)).toEqual([]);
    const older = (await get(id, `beforeTurn=${P(4)}&count=5`)).body;
    expect(turnNs(older)).toEqual([1, 2, 3]);
    expect(older.data.hasOlder).toBe(false);
  });

  test("a bad query or an unknown turn says so", async () => {
    const id = writeClaudeSession();
    expect((await get(id, "turn=not%20an%20id")).status).toBe(400);
    expect((await get(id, `turn=${P(1)}&afterTurn=${P(2)}`)).status).toBe(400);
    expect((await get(id, `turn=${P(99)}`)).body.code).toBe("not_found");
    expect((await get(randomUUID(), `turn=${P(1)}`)).status).toBe(404);
  });

  test("a Codex turn a rollback removed answers 410 rolled_back", async () => {
    const id = randomUUID();
    const T = (n: number) => `019ee344-2222-7000-8000-00000000000${n}`;
    const dir = join(sessionsDir, "2026", "11", "04");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-2026-11-04T00-00-00-${id}.jsonl`), lines(
      codex.meta(id, projectPath),
      codex.taskStarted(T(1)), codex.user("one"), codex.agent("a1"), codex.taskComplete(T(1)),
      codex.taskStarted(T(2)), codex.user("two"), codex.agent("a2"), codex.taskComplete(T(2)),
      codex.rolledBack(1),
      codex.taskStarted(T(3)), codex.user("three"), codex.agent("a3"), codex.taskComplete(T(3)),
    ));
    const gone = await get(id, `turn=${T(2)}`, "codex");
    expect(gone.status).toBe(410);
    expect(gone.body.code).toBe("rolled_back");
    const kept = await get(id, `turn=${T(3)}`, "codex");
    expect(kept.body.data.turns.map((t: { turnId: string; n: number }) => [t.turnId, t.n])).toEqual([[T(1), 1], [T(3), 2]]);
  });

  test("a Codex window gives every message an id no other turn in it shares", async () => {
    const id = randomUUID();
    const T = (n: number) => `019ee344-3333-7000-8000-00000000000${n}`;
    const dir = join(sessionsDir, "2026", "11", "04");
    mkdirSync(dir, { recursive: true });
    const records: string[] = [codex.meta(id, projectPath)];
    for (let n = 1; n <= 3; n++) records.push(codex.taskStarted(T(n)), codex.user(`ask ${n}`), codex.agent(`answer ${n}`), codex.taskComplete(T(n)));
    writeFileSync(join(dir, `rollout-2026-11-04T00-00-01-${id}.jsonl`), lines(...records));
    const { body } = await get(id, `turn=${T(2)}`, "codex");
    const messages = body.data.messages as ChatMessage[];
    expect(messages.length).toBe(6);
    expect(new Set(messages.map((m) => m.id)).size).toBe(messages.length);
    // Each id names its turn, so a row found by id is in the turn it belongs to.
    for (const m of messages) expect(m.id.startsWith(`${m.turnId}:`)).toBe(true);
    expect(messages.find((m) => m.content === "ask 3")!.turnId).toBe(T(3));
  });
});

describe("pickWindowTurns", () => {
  const turns = (counts: number[]): SessionTurnSummary[] => counts.map((messageCount, i) => ({
    turnId: P(i + 1), n: i + 1, startedAt: "", prompt: "", messageCount, status: "complete",
  }));

  test("never more than the turn cap", () => {
    const all = turns(Array(40).fill(2));
    const { from, to } = pickWindowTurns(all, 20, { kind: "around", turnId: P(21), before: 10, after: 10 });
    expect(to - from).toBeLessThanOrEqual(TURN_WINDOW_MAX_TURNS);
    expect(from).toBeLessThanOrEqual(20);
    expect(to).toBeGreaterThan(20);
  });

  test("stops adding neighbours at the message cap, but always keeps the turn asked for", () => {
    const all = turns([150, 150, 500, 150, 150]);
    expect(pickWindowTurns(all, 2, { kind: "around", turnId: P(3), before: 2, after: 3 })).toEqual({ from: 2, to: 3 });
    const fits = turns([100, 100, 100, 100, 100, 100]);
    const r = pickWindowTurns(fits, 2, { kind: "around", turnId: P(3), before: 2, after: 3 });
    const sum = fits.slice(r.from, r.to).reduce((s, t) => s + t.messageCount, 0);
    expect(sum).toBeLessThanOrEqual(TURN_WINDOW_MAX_MESSAGES);
    expect(r).toEqual({ from: 0, to: 4 });
  });

  test("a page after a turn always moves on, even past the message cap", () => {
    const all = turns([1, 900, 1]);
    expect(pickWindowTurns(all, 0, { kind: "after", turnId: P(1), count: 3 })).toEqual({ from: 1, to: 2 });
    expect(pickWindowTurns(all, 2, { kind: "before", turnId: P(3), count: 3 })).toEqual({ from: 1, to: 2 });
  });

  test("counts are clamped to the cap", () => {
    expect(parseTurnWindowQuery((n) => ({ afterTurn: P(1), count: "99" } as Record<string, string>)[n])).toEqual({ kind: "after", turnId: P(1), count: TURN_WINDOW_MAX_TURNS });
    expect(parseTurnWindowQuery((n) => ({ turn: P(1) } as Record<string, string>)[n])).toEqual({ kind: "around", turnId: P(1), before: 2, after: 3 });
  });
});
