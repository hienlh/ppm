/**
 * Run all: the approved tasks, wave by wave, each in a chat of its own.
 *
 * The AI decided the order when it wrote tasks.md (`_Deps:_`, `_Files:_`); `planWaves` turned
 * that into waves PPM has checked. A wave's tasks start side by side (at most
 * {@link MAX_PARALLEL_TASKS} chats at once), each chat bound to its one task, which the spec tools
 * then hold it to. A task finishes only through the spec tools — `task_done`, or `task_green` in
 * Thorough — so the scheduler only watches: a finished task frees its slot, a chat that went idle
 * without finishing marks its task failed and the run stops after the wave. In Thorough the whole
 * suite is checked once a wave has finished, before the next one starts.
 *
 * Runs live in this process: a restart leaves the spec's run marked active with no controller,
 * which the view reports as interrupted (`isRunLive`), and the user starts it again.
 */
import { createLogger } from "../logger.ts";
import { onSpecEvent } from "./spec-events.ts";
import { bindSpecSession, unbindSpecSession } from "./spec-store.ts";
import {
  checkSuite, getSpec, resetTask, setRunLiveProbe, setRunState, startTask, type SpecTaskView, type SpecView,
} from "./spec.service.ts";

const log = createLogger("spec-run");

export const MAX_PARALLEL_TASKS = 3;
/** How long a task's chat may sit idle with its task unfinished before the task counts as failed. */
export const IDLE_GRACE_MS = 20_000;
const TICK_MS = 3_000;

export interface SpecSchedulerEnv {
  /** A new chat in the project, for one task; returns its id. */
  createTaskSession(input: {
    projectPath: string; projectName: string; providerId: string; title: string; permissionMode?: string; parentSessionId?: string;
  }): Promise<string>;
  /** Sends PPM's message into a chat, starting its turn. */
  deliver(input: { sessionId: string; providerId: string; projectPath: string; projectName: string; text: string }): Promise<void>;
  /** Whether the chat has a turn in flight. */
  isTurnRunning(sessionId: string): boolean;
  /** Stops the chat's turn. */
  stopTurn(providerId: string, sessionId: string): void;
  projectNameOf(projectPath: string): string | null;
}

let env: SpecSchedulerEnv | null = null;
export function setSpecSchedulerEnv(next: SpecSchedulerEnv | null): void {
  env = next;
}

interface Child {
  sessionId: string;
  startedAt: number;
  idleSince?: number;
}

interface RunControl {
  projectPath: string;
  slug: string;
  providerId: string;
  permissionMode?: string;
  children: Map<string, Child>;
  /** Wave whose whole-suite check has run (Thorough). */
  checkedWave: number;
  timer: ReturnType<typeof setInterval>;
  offEvents: () => void;
  ticking: boolean;
  again: boolean;
  stopped: boolean;
}

const runs = new Map<string, RunControl>();
const keyOf = (projectPath: string, slug: string) => `${projectPath}\0${slug}`;

setRunLiveProbe((projectPath, slug) => runs.has(keyOf(projectPath, slug)));

export function isRunning(projectPath: string, slug: string): boolean {
  return runs.has(keyOf(projectPath, slug));
}

/** The wave holding the first required task not done yet, or -1 when every one is. */
function currentWave(v: SpecView): number {
  for (let i = 0; i < v.waves.waves.length; i++) {
    const ids = v.waves.waves[i]!;
    if (ids.some((id) => !v.tasks.find((t) => t.id === id)?.done)) return i;
  }
  return -1;
}

export type RunResult = { ok: true; message: string } | { ok: false; message: string };

export async function startRun(projectPath: string, slug: string, opts: { providerId: string; permissionMode?: string }): Promise<RunResult> {
  if (!env) return { ok: false, message: "Running tasks needs PPM's server." };
  const key = keyOf(projectPath, slug);
  if (runs.has(key)) return { ok: false, message: "The tasks are already running." };
  const v = await getSpec(projectPath, slug);
  if (v.current !== "execution") return { ok: false, message: `Approve ${v.current} first.` };
  if (v.waves.issues.some((i) => i.severity === "error")) return { ok: false, message: v.waves.issues[0]!.message };
  const wave = currentWave(v);
  if (wave < 0) return { ok: false, message: "Every required task is already done." };
  if (v.suite?.newFailures.length) return { ok: false, message: "The whole suite has new failures; fix them and check the suite first." };

  const ctl: RunControl = {
    projectPath, slug, providerId: opts.providerId, permissionMode: opts.permissionMode,
    children: new Map(), checkedWave: wave - 1, ticking: false, again: false, stopped: false,
    timer: setInterval(() => void tick(ctl), TICK_MS),
    offEvents: onSpecEvent((e) => { if (e.projectPath === projectPath && e.slug === slug) void tick(ctl); }),
  };
  // Tasks a chat started by hand stay that chat's: the run waits for them like for its own.
  for (const t of v.tasks) {
    if ((t.status === "running" || t.status === "red") && t.run?.sessionId) ctl.children.set(t.id, { sessionId: t.run.sessionId, startedAt: Date.now() });
  }
  runs.set(key, ctl);
  await setRunState(projectPath, slug, { active: true, startedAt: new Date().toISOString(), wave });
  log.info(`spec ${slug}: run started at wave ${wave + 1} with ${opts.providerId}`);
  void tick(ctl);
  return { ok: true, message: `Running from wave ${wave + 1}.` };
}

export async function stopRun(projectPath: string, slug: string): Promise<RunResult> {
  const ctl = runs.get(keyOf(projectPath, slug));
  if (!ctl) {
    // A run a restart interrupted: just clear its mark.
    await setRunState(projectPath, slug, null);
    return { ok: true, message: "Stopped." };
  }
  await finish(ctl, "stopped", true);
  return { ok: true, message: "Stopped. Tasks that were running are back to not started." };
}

async function finish(ctl: RunControl, why: "done" | "stopped" | "blocked" | "failed", stopChildren: boolean, blocked?: { wave: number; failing: string[] }): Promise<void> {
  if (ctl.stopped) return;
  ctl.stopped = true;
  clearInterval(ctl.timer);
  ctl.offEvents();
  runs.delete(keyOf(ctl.projectPath, ctl.slug));
  if (stopChildren) {
    for (const [id, child] of ctl.children) {
      try { env?.stopTurn(ctl.providerId, child.sessionId); } catch (e) { log.warn(`spec ${ctl.slug}: could not stop task ${id}: ${(e as Error).message}`); }
      await resetTask(ctl.projectPath, ctl.slug, id, "todo");
      unbindSpecSession(child.sessionId);
    }
  }
  const v = await getSpec(ctl.projectPath, ctl.slug);
  await setRunState(ctl.projectPath, ctl.slug, {
    active: false, startedAt: v.run?.startedAt ?? new Date().toISOString(), wave: v.run?.wave ?? 0, stoppedAt: new Date().toISOString(),
    ...(blocked ? { suiteBlocked: { ...blocked, at: new Date().toISOString() } } : {}),
  });
  log.info(`spec ${ctl.slug}: run ${why}`);
}

/** One look at the spec: retire finished or stalled chats, check a finished wave, start what is ready. */
async function tick(ctl: RunControl): Promise<void> {
  if (ctl.stopped) return;
  if (ctl.ticking) { ctl.again = true; return; }
  ctl.ticking = true;
  try {
    do {
      ctl.again = false;
      await step(ctl);
    } while (ctl.again && !ctl.stopped);
  } catch (e) {
    log.error(`spec ${ctl.slug}: run step failed: ${(e as Error).message}`);
  } finally {
    ctl.ticking = false;
  }
}

async function step(ctl: RunControl): Promise<void> {
  if (!env || ctl.stopped) return;
  let v = await getSpec(ctl.projectPath, ctl.slug);
  if (v.current !== "execution") { await finish(ctl, "stopped", true); return; }

  // Retire chats whose task finished, and fail the ones that stopped without finishing it.
  const now = Date.now();
  for (const [id, child] of [...ctl.children]) {
    const t = v.tasks.find((x) => x.id === id);
    if (!t || t.done) { ctl.children.delete(id); continue; }
    if (t.status === "failed" || t.status === "todo") { ctl.children.delete(id); continue; }
    if (env.isTurnRunning(child.sessionId)) { child.idleSince = undefined; continue; }
    child.idleSince ??= now;
    if (now - child.idleSince >= IDLE_GRACE_MS) {
      log.warn(`spec ${ctl.slug}: task ${id}'s chat went idle without finishing it`);
      await resetTask(ctl.projectPath, ctl.slug, id, "failed", "The task's chat stopped before finishing it. Open the chat to see why, then start the run again.");
      ctl.children.delete(id);
    }
  }
  if (ctl.children.size === 0) v = await getSpec(ctl.projectPath, ctl.slug);

  const wave = currentWave(v);
  // Thorough: once every task of a wave is in, the whole suite is checked before the next wave.
  if (v.checks === "thorough" && v.testCommand && ctl.children.size === 0) {
    const finishedWave = wave < 0 ? v.waves.waves.length - 1 : wave - 1;
    if (finishedWave > ctl.checkedWave) {
      const suite = await checkSuite(ctl.projectPath, ctl.slug);
      ctl.checkedWave = finishedWave;
      if (!suite.ok) {
        await finish(ctl, "blocked", false, { wave: finishedWave, failing: suite.view.suite?.newFailures ?? [] });
        return;
      }
      v = suite.view;
    }
  }
  if (wave < 0) { await finish(ctl, "done", false); return; }
  if (v.run?.wave !== wave) await setRunState(ctl.projectPath, ctl.slug, { ...(v.run ?? { active: true, startedAt: new Date().toISOString() }), active: true, wave });
  // A failed task holds only what comes after it: the rest of its wave still runs, and the run
  // ends once nothing is running and nothing else can start.
  const ready = v.waves.waves[wave]!
    .map((id) => v.tasks.find((t) => t.id === id))
    .filter((t): t is SpecTaskView => !!t && t.next === "start" && t.status !== "failed" && !ctl.children.has(t.id));
  for (const t of ready) {
    if (ctl.children.size >= MAX_PARALLEL_TASKS || ctl.stopped) break;
    await startChild(ctl, v, t);
  }
  if (ctl.children.size === 0 && !ctl.stopped) await finish(ctl, "failed", false);
}

async function startChild(ctl: RunControl, v: SpecView, t: SpecTaskView): Promise<void> {
  const projectName = env!.projectNameOf(ctl.projectPath);
  if (!projectName) throw new Error("the project is no longer registered");
  const sessionId = await env!.createTaskSession({
    projectPath: ctl.projectPath, projectName, providerId: ctl.providerId,
    title: `${v.title} · ${t.id}. ${t.title}`.slice(0, 120), permissionMode: ctl.permissionMode,
    ...(v.sessionId ? { parentSessionId: v.sessionId } : {}),
  });
  bindSpecSession(sessionId, { projectPath: ctl.projectPath, slug: ctl.slug, taskId: t.id });
  const started = await startTask(ctl.projectPath, ctl.slug, t.id, { sessionId });
  if (!started.ok) {
    unbindSpecSession(sessionId);
    log.warn(`spec ${ctl.slug}: task ${t.id} could not start: ${started.message}`);
    return;
  }
  ctl.children.set(t.id, { sessionId, startedAt: Date.now() });
  const steps = v.checks === "thorough" && !t.noTest
    ? "write its failing tests, call task_red, then the code, then task_green"
    : "do the work, then call task_done with a one-line summary";
  const text = `Run task ${t.id} of the spec "${v.title}": ${t.title}.\n\nRead ${v.folder}/ (requirements, design, tasks.md) first, then ${steps}. Touch only this task's files: other tasks run beside you.`;
  try {
    await env!.deliver({ sessionId, providerId: ctl.providerId, projectPath: ctl.projectPath, projectName, text });
  } catch (e) {
    log.error(`spec ${ctl.slug}: task ${t.id}'s message did not reach its chat: ${(e as Error).message}`);
    await resetTask(ctl.projectPath, ctl.slug, t.id, "failed", `The task's chat could not be started: ${(e as Error).message}`);
    ctl.children.delete(t.id);
  }
}
