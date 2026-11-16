import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../../../test-setup.ts";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getDb } from "../../../../../src/services/db.service.ts";
import type { ChatControl, LiveChatState, SendUserMessageOpts } from "../../../../../src/services/chat-control/chat-control.ts";
import { createTask, updateTask } from "../../../../../src/services/ppm-tasks/ppm-tasks.service.ts";
import { setPpmTasksDeliverEnv, wakeManager, type DeliverOutcome } from "../../../../../src/services/ppm-tasks/ppm-tasks-deliver.ts";
import { enableOnManagerAssigned } from "../../../../../src/services/ppm-tasks/ppm-tasks-projects.service.ts";
import { createChildCheckRunner, MAX_BUSY_TRIES, type ChildCheckEnv } from "../../../../../src/services/ppm-tasks/child-check/child-check-runner.ts";
import { chatOf, freshProject, PROJECT_PATH, USER, type Fixture } from "../ppm-tasks-fixture.ts";

const MIN = 60_000;
const FIXTURE = resolve(import.meta.dir, "../../../../fixtures/ppm-tasks/benchmark-memory-wait.jsonl");
const HANDOFF = Date.parse("2026-11-15T19:36:00Z");
const LAST_PROGRESS = Date.parse("2026-11-15T19:37:11Z");

let f: Fixture;
let dir: string;
let file: string;
let clock: number;
let live: LiveChatState | null;
let exists: boolean;
let wakes: Array<{ at: number; projectKey: string; lines: string[] }>;
let wakeAnswer: DeliverOutcome;
let cards: Array<{ title: string; body: string; manager: string | null }>;
let emitted: string[][];
let subagents: number | null;

function env(over: Partial<ChildCheckEnv> = {}): ChildCheckEnv {
  return {
    now: () => clock,
    liveState: () => live,
    sessionExists: () => exists,
    providerOf: () => "claude",
    chatTitle: () => "Child chat",
    locate: async () => ({ path: file, subagentsDir: join(dir, "subagents") }),
    subagentActivity: async () => subagents,
    wake: async (projectKey, lines) => { wakes.push({ at: clock, projectKey, lines }); return wakeAnswer; },
    postCard: (_k, _n, manager, title, body) => { cards.push({ title, body, manager }); },
    emit: (keys) => { emitted.push(keys); },
    ...over,
  };
}

const running = (o: Partial<LiveChatState> = {}): LiveChatState => ({ phase: "streaming", running: true, projectName: "demo", providerId: "claude", queuedCards: 0, ...o });

function addManager(): void {
  getDb().query(
    "INSERT INTO manager_chats (project_key, project_path, session_id, provider_id, assigned_by, assigned_at) VALUES (?, ?, 'mgr-1', 'claude', 'user', 1)",
  ).run(f.projectKey, PROJECT_PATH);
  enableOnManagerAssigned(f.projectKey, PROJECT_PATH);
}

/** A task handed off to `child` at `HANDOFF`. */
function handedOff(child = "child-1", title = "Run the benchmark") {
  const t = createTask({ projectKey: f.projectKey, title }, USER);
  const u = updateTask(t.id, { workingSessionId: chatOf(child) }, t.revision, USER);
  getDb().query("UPDATE tasks SET handed_off_at = ? WHERE id = ?").run(HANDOFF, t.id);
  return u;
}

const checkRow = (taskId: string) => getDb().query("SELECT * FROM task_child_checks WHERE task_id = ?").get(taskId) as Record<string, any> | null;

beforeEach(() => {
  f = freshProject();
  addManager();
  dir = mkdtempSync(join(tmpdir(), "ppm-child-check-"));
  file = join(dir, "child.jsonl");
  writeFileSync(file, "");
  clock = HANDOFF;
  live = running();
  exists = true;
  wakes = [];
  wakeAnswer = { ok: true, sessionId: "mgr-1", delivered: "started" };
  cards = [];
  emitted = [];
  subagents = null;
});
afterEach(() => {
  setPpmTasksDeliverEnv(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("the benchmark wait loop replayed on a fake clock", () => {
  it("is reported stalled exactly at last progress + 30 min and + 90 min, never again", async () => {
    const records = readFileSync(FIXTURE, "utf8").trim().split("\n");
    let next = 0;
    const task = handedOff();
    const runner = createChildCheckRunner(env());
    for (clock = HANDOFF; clock <= HANDOFF + 4 * 60 * MIN; clock += MIN) {
      while (next < records.length && Date.parse(JSON.parse(records[next]!).timestamp) <= clock) appendFileSync(file, `${records[next++]}\n`);
      await runner.tick();
    }
    expect(wakes).toHaveLength(2);
    expect(wakes[0]!.at).toBeGreaterThanOrEqual(LAST_PROGRESS + 30 * MIN);
    expect(wakes[0]!.at).toBeLessThan(LAST_PROGRESS + 31 * MIN);
    expect(wakes[1]!.at).toBeGreaterThanOrEqual(LAST_PROGRESS + 90 * MIN);
    expect(wakes[1]!.at).toBeLessThan(LAST_PROGRESS + 91 * MIN);
    expect(wakes[0]!.lines[0]).toContain('demo/1 "Run the benchmark"');
    expect(wakes[0]!.lines[0]).toMatch(/stalled, no new output for 3[01] min/);
    // The child's own tool call is quoted; the tool's output (text it read) never is.
    const quoted = wakes[0]!.lines.filter((l) => l.includes("quoted output"));
    expect(quoted.some((l) => l.includes("Bash tail -n 1"))).toBe(true);
    expect(quoted.some((l) => l.includes("committed; waiting"))).toBe(false);
    const row = checkRow(task.id)!;
    expect(row.state).toBe("stalled");
    expect(row.last_progress_at).toBe(LAST_PROGRESS);
    expect(row.alerts).toBe(2);
    expect(row.transcript_offset).toBe(statSync(file).size);
  });
});

describe("child checks", () => {
  it("a child showing a card is waiting_card and wakes nobody", async () => {
    const task = handedOff();
    live = running({ card: { requestId: "r1", tool: "Bash", input: {}, isQuestion: false } });
    const runner = createChildCheckRunner(env());
    clock = HANDOFF + 31 * MIN;
    await runner.tick();
    expect(checkRow(task.id)!.state).toBe("waiting_card");
    expect(wakes).toEqual([]);
    expect(emitted).toEqual([[f.projectKey]]);
  });

  it("an idle child with no result wakes the manager once with a finished_no_report line", async () => {
    const task = handedOff();
    appendFileSync(file, `${JSON.stringify({ type: "assistant", timestamp: new Date(HANDOFF + MIN).toISOString(), message: { content: [{ type: "text", text: "All done." }] } })}\n`);
    utimesSync(file, (HANDOFF + MIN) / 1000, (HANDOFF + MIN) / 1000);
    live = null;
    const runner = createChildCheckRunner(env());
    clock = HANDOFF + 30 * MIN;
    await runner.tick();
    expect(checkRow(task.id)!.state).toBe("finished_no_report");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.lines[0]).toContain("finished without a result (went idle)");
    clock += 10 * MIN;
    await runner.tick();
    clock += 30 * MIN;
    await runner.tick();
    expect(wakes).toHaveLength(1);
  });

  it("stops checking once the task has a result, and its row is gone", async () => {
    const task = handedOff();
    const runner = createChildCheckRunner(env());
    clock = HANDOFF + 30 * MIN;
    await runner.tick();
    expect(checkRow(task.id)).not.toBeNull();
    updateTask(task.id, { result: { text: "Benchmark done: 4 runs" } }, task.revision, USER);
    clock += 30 * MIN;
    await runner.tick();
    expect(checkRow(task.id)).toBeNull();
  });

  it("a deleted child is reported as no longer existing", async () => {
    handedOff();
    exists = false;
    const runner = createChildCheckRunner(env());
    clock = HANDOFF + 30 * MIN;
    await runner.tick();
    expect(wakes[0]!.lines[0]).toContain("session no longer exists");
  });

  it("posts one card instead when the wake budget is spent, naming every task", async () => {
    handedOff("child-1", "First");
    handedOff("child-2", "Second");
    wakeAnswer = { ok: false, reason: "budget", error: "used" };
    const runner = createChildCheckRunner(env());
    clock = HANDOFF + 31 * MIN;
    await runner.tick();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.lines.filter((l) => l.startsWith("- demo/"))).toHaveLength(2);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.title).toBe("2 handed-off tasks need a look");
    expect(cards[0]!.body).toContain('"First"');
    expect(cards[0]!.body).toContain('"Second"');
    expect(cards[0]!.manager).toBe("mgr-1");
  });

  it("asks a busy manager again at the next tick and counts one alert", async () => {
    const task = handedOff();
    wakeAnswer = { ok: false, reason: "busy", error: "busy" };
    const runner = createChildCheckRunner(env());
    clock = HANDOFF + 31 * MIN;
    await runner.tick();
    expect(checkRow(task.id)!.alerts).toBe(0);
    wakeAnswer = { ok: true, sessionId: "mgr-1", delivered: "started" };
    clock += MIN;
    await runner.tick();
    expect(wakes).toHaveLength(2);
    expect(checkRow(task.id)!.alerts).toBe(1);
    expect(cards).toEqual([]);
  });

  it("forgets a pending retry once the child makes progress again", async () => {
    const task = handedOff();
    wakeAnswer = { ok: false, reason: "busy", error: "busy" };
    let looks = 0;
    const runner = createChildCheckRunner(env({ liveState: () => { looks++; return live; } }));
    clock = HANDOFF + 31 * MIN;
    await runner.tick();
    expect(looks).toBe(1);
    appendFileSync(file, `${JSON.stringify({ type: "assistant", timestamp: new Date(clock + 30_000).toISOString(), message: { content: [{ type: "text", text: "Step 2 of 5" }] } })}\n`);
    clock += MIN;
    await runner.tick();
    expect(looks).toBe(2);
    expect(checkRow(task.id)!.state).toBe("running");
    clock += MIN;
    await runner.tick();
    // Not looked at again until a decision falls due: the retry is gone.
    expect(looks).toBe(2);
    expect(wakes).toHaveLength(1);
  });

  it("posts the card instead after the manager stayed busy for 15 ticks", async () => {
    const task = handedOff();
    wakeAnswer = { ok: false, reason: "busy", error: "busy" };
    const runner = createChildCheckRunner(env());
    clock = HANDOFF + 31 * MIN;
    for (let i = 0; i <= MAX_BUSY_TRIES; i++) { await runner.tick(); clock += MIN; }
    expect(wakes).toHaveLength(MAX_BUSY_TRIES);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.body).toContain("busy for 15 minutes");
    expect(checkRow(task.id)!.alerts).toBe(1);
  });

  it("a subagent still writing keeps a quiet child from reading as stalled", async () => {
    const task = handedOff();
    const runner = createChildCheckRunner(env());
    clock = HANDOFF + 31 * MIN;
    subagents = clock - MIN;
    await runner.tick();
    expect(checkRow(task.id)!.state).toBe("running");
    expect(wakes).toEqual([]);
  });

  it("starts the count over when the task is handed to another chat", async () => {
    const task = handedOff();
    const runner = createChildCheckRunner(env());
    clock = HANDOFF + 31 * MIN;
    await runner.tick();
    expect(checkRow(task.id)!.alerts).toBe(1);
    updateTask(task.id, { workingSessionId: chatOf("child-2") }, task.revision, USER);
    getDb().query("UPDATE tasks SET handed_off_at = ? WHERE id = ?").run(clock, task.id);
    clock += 31 * MIN;
    await runner.tick();
    const row = checkRow(task.id)!;
    expect(row.session_id).toBe("child-2");
    expect(row.alerts).toBe(1);
  });

  it("does nothing when no task is handed off", async () => {
    const t = createTask({ projectKey: f.projectKey, title: "Manager's own" }, USER);
    const runner = createChildCheckRunner(env({ liveState: () => { throw new Error("looked at a chat"); } }));
    clock = HANDOFF + 300 * MIN;
    await runner.tick();
    expect(checkRow(t.id)).toBeNull();
    expect(wakes).toEqual([]);
  });
});

describe("the live wake path", () => {
  it("wakes the manager with an unattended watch turn and never sends the child anything", async () => {
    handedOff();
    const sent: Array<{ sessionId: string; text: string; opts: SendUserMessageOpts }> = [];
    const looked: string[] = [];
    const chat: ChatControl = {
      sendUserMessage: async (sessionId, text, opts) => { sent.push({ sessionId, text, opts }); return { ok: true, sessionId }; },
      answerApproval: () => { throw new Error("answered a card"); },
      cancelTurn: () => { throw new Error("stopped a turn"); },
      liveState: (id) => { looked.push(id); return running(); },
      listLive: () => [],
    };
    setPpmTasksDeliverEnv({ chat: () => chat, reserveWake: () => ({ ok: true, release: () => {} }) });
    const runner = createChildCheckRunner(env({
      liveState: (id) => chat.liveState(id),
      wake: (projectKey, lines) => wakeManager(projectKey, { kind: "ppm", label: "PPM" }, lines, { unattended: true }),
    }));
    clock = HANDOFF + 31 * MIN;
    await runner.tick();
    expect(looked).toEqual(["child-1"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.sessionId).toBe("mgr-1");
    expect(sent[0]!.opts.origin).toBe("watch");
    expect(sent[0]!.text).toContain("PPM Tasks — handed-off work in demo needs you:");
    expect(sent[0]!.text).toContain("stalled, no new output");
  });

  it("a busy manager answers busy and keeps the budget", async () => {
    handedOff();
    let released = 0;
    setPpmTasksDeliverEnv({
      chat: () => ({ sendUserMessage: async () => ({ ok: false, error: "busy" }), answerApproval: () => "stale", cancelTurn: () => false, liveState: () => null, listLive: () => [] }),
      reserveWake: () => ({ ok: true, release: () => { released++; } }),
    });
    const out = await wakeManager(f.projectKey, { kind: "ppm", label: "PPM" }, ["- finding"], { unattended: true });
    expect(out).toEqual({ ok: false, reason: "busy", error: "busy" });
    expect(released).toBe(1);
  });
});
