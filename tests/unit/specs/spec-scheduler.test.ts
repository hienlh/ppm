/**
 * Run all with a scripted environment: the "chats" are fakes that finish their task through the
 * spec service the way an agent's `task_done` would. Checks the waves, the parallel cap, a chat
 * that stops without finishing, and Stop.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PPM_HOME = mkdtempSync(join(tmpdir(), "ppm-spec-run-home-"));

const svc = await import("../../../src/services/specs/spec.service.ts");
const sched = await import("../../../src/services/specs/spec-scheduler.ts");
const { resetSpecSessionsCache, specForSession } = await import("../../../src/services/specs/spec-store.ts");

const REQ = "# R\n\nUI: no\n\n### Requirement 1: A\n\n#### Acceptance Criteria\n\n1. WHEN x THE SYSTEM SHALL y\n";
// 1, 2, 3, 4 independent (wave 1, capped at 3 at once); 5 depends on 1 (wave 2).
const TASKS = [1, 2, 3, 4].map((n) => `- [ ] ${n}. T${n}\n  - _Requirements: 1.1_\n  - _Files: f${n}.ts_\n`).join("")
  + "- [ ] 5. T5\n  - _Requirements: 1.1_\n  - _Deps: 1_\n  - _Files: f5.ts_\n";

let project: string;
let running: Set<string>;
let delivered: { sessionId: string; text: string }[];
let maxAtOnce: number;
let n = 0;
/** What each fake chat does with its task: finish it, or go idle without finishing. */
let behaviour: (taskId: string) => "finish" | "stall" | "hang";

function useEnv() {
  sched.setSpecSchedulerEnv({
    projectNameOf: () => "proj",
    createTaskSession: async () => `task-chat-${++n}`,
    isTurnRunning: (id) => running.has(id),
    stopTurn: (_p, id) => { running.delete(id); },
    deliver: async ({ sessionId, text }) => {
      delivered.push({ sessionId, text });
      running.add(sessionId);
      maxAtOnce = Math.max(maxAtOnce, running.size);
      const taskId = specForSession(sessionId)!.taskId!;
      const what = behaviour(taskId);
      if (what === "hang") return;
      setTimeout(async () => {
        if (what === "finish") await svc.taskDone(project, "s", taskId, "done");
        running.delete(sessionId);
      }, 30);
    },
  });
}

async function approved() {
  await svc.createSpec(project, { title: "S", slug: "s", sessionId: "main" });
  const dir = join(project, "specs", "s");
  writeFileSync(join(dir, "requirements.md"), REQ);
  await svc.approvePhase(project, "s", "requirements");
  await svc.approvePhase(project, "s", "design");
  writeFileSync(join(dir, "tasks.md"), TASKS);
  expect((await svc.approvePhase(project, "s", "tasks")).ok).toBe(true);
}

async function until(cond: () => Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await Bun.sleep(25);
  }
  throw new Error("timed out");
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "ppm-spec-run-proj-"));
  resetSpecSessionsCache();
  running = new Set();
  delivered = [];
  maxAtOnce = 0;
  behaviour = () => "finish";
  useEnv();
});

describe("Run all", () => {
  it("runs every task, three at a time, a dependent one after its wave", async () => {
    await approved();
    expect((await sched.startRun(project, "s", { providerId: "claude" })).ok).toBe(true);
    await until(async () => !sched.isRunning(project, "s"));
    const v = await svc.getSpec(project, "s");
    expect(v.tasks.every((t) => t.done)).toBe(true);
    expect(maxAtOnce).toBeLessThanOrEqual(sched.MAX_PARALLEL_TASKS);
    expect(delivered.length).toBe(5);
    // Task 5 was handed out after task 1 finished.
    expect(delivered.findIndex((d) => d.text.includes("Run task 5"))).toBeGreaterThan(delivered.findIndex((d) => d.text.includes("Run task 1")));
    expect(v.run?.active).toBe(false);
  });

  it("refuses to run before the tasks are approved", async () => {
    await svc.createSpec(project, { title: "S", slug: "s" });
    expect((await sched.startRun(project, "s", { providerId: "claude" })).ok).toBe(false);
  });

  it("Stop puts running tasks back and stops their chats", async () => {
    await approved();
    behaviour = () => "hang";
    await sched.startRun(project, "s", { providerId: "claude" });
    await until(async () => delivered.length === 3);
    expect(running.size).toBe(3);
    await sched.stopRun(project, "s");
    expect(running.size).toBe(0);
    const v = await svc.getSpec(project, "s");
    expect(v.tasks.filter((t) => t.status === "running")).toEqual([]);
    expect(v.run?.active).toBe(false);
    expect(v.runLive).toBe(false);
  });
});
