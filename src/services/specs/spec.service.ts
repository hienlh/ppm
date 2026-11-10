/**
 * Spec mode's one door: every change to a spec — from the AI's tools, the REST routes, the
 * scheduler or the CLI — goes through these functions, under one lock per spec, after asking
 * `spec-gates.ts` whether it may happen.
 */
import { join } from "node:path";
import {
  loadSpecState, saveSpecState, readSpecDoc, writeSpecDoc, resolveSpecDir, listSpecSlugs, slugFromTitle,
  bindSpecSession, hashFile, hasSpecState, SpecError,
} from "./spec-store.ts";
import { evaluateSpec, type SpecEvaluation, type GateDocs } from "./spec-gates.ts";
import type { SpecTaskView, SpecView } from "../../shared/spec-view.ts";
import { runTestCommand, expandTestCommand, DEFAULT_SUITE_TIMEOUT_MS, DEFAULT_TASK_TIMEOUT_MS, type TestRun } from "./test-runner.ts";
import { newFailures } from "./test-judge.ts";
import { designTemplate, requirementsTemplate, tasksTemplate } from "./spec-templates.ts";
import { emitSpecEvent } from "./spec-events.ts";
import { drawingHash } from "./spec-design-link.ts";
import { setTaskChecked, type SpecIssue } from "../../shared/spec-format.ts";
import type { WavePlan } from "../../shared/spec-waves.ts";
import {
  isValidSpecSlug, phaseFileName, SPECS_DIR,
  type PhaseStatus, type SpecChecks, type SpecKind, type SpecPhase, type SpecRunRecord, type SpecState,
  type SpecSummary, type SpecTaskState, type SpecWorkflow, type TaskStatus,
} from "../../shared/spec-types.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("spec");

// ─── views ────────────────────────────────────────────────────────────────────

export type { SpecTaskView, SpecView } from "../../shared/spec-view.ts";

export interface SpecContext {
  projectPath: string;
  dir: string;
  state: SpecState;
  docs: GateDocs;
  evaluation: SpecEvaluation;
}

// ─── hooks other subsystems fill in ───────────────────────────────────────────

/** Content hash of a spec's PPM Design right now (`spec-design-link.ts`; replaceable in tests). */
let drawingHashFn: (projectPath: string, designSlug: string) => Promise<string | null> = drawingHash;
export function setDrawingHashProvider(fn: typeof drawingHashFn): void {
  drawingHashFn = fn;
}

/** Whether the scheduler is driving a run of this spec (set by `spec-scheduler.ts`). */
let runLiveFn: (projectPath: string, slug: string) => boolean = () => false;
export function setRunLiveProbe(fn: typeof runLiveFn): void {
  runLiveFn = fn;
}

// ─── locking ──────────────────────────────────────────────────────────────────

const locks = new Map<string, Promise<unknown>>();

/** Runs `fn` after every earlier call for the same spec has finished. */
export function withSpecLock<T>(projectPath: string, slug: string, fn: () => Promise<T>): Promise<T> {
  const key = `${projectPath}\0${slug}`;
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  void next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => {});
  return next;
}

// ─── reading ──────────────────────────────────────────────────────────────────

async function kindOnDisk(dir: string): Promise<SpecKind> {
  return (await hashFile(join(dir, "bugfix.md"))) ? "bugfix" : "feature";
}

export async function loadSpec(projectPath: string, slug: string): Promise<SpecContext> {
  const dir = await resolveSpecDir(projectPath, slug);
  const state = loadSpecState(projectPath, slug, hasSpecState(projectPath, slug) ? undefined : await kindOnDisk(dir));
  const docs: GateDocs = {
    requirements: await readSpecDoc(dir, state.kind, "requirements"),
    design: await readSpecDoc(dir, state.kind, "design"),
    tasks: await readSpecDoc(dir, state.kind, "tasks"),
  };
  const drawingHash = state.designSlug ? await drawingHashFn(projectPath, state.designSlug) : null;
  const evaluation = evaluateSpec(docs, state, { drawingHash });
  return { projectPath, dir, state, docs, evaluation };
}

const baselineRuns = new Set<string>();
const suiteRuns = new Set<string>();
const runKey = (projectPath: string, slug: string) => `${projectPath}\0${slug}`;

export function toView(ctx: SpecContext): SpecView {
  const { state, evaluation: ev, docs } = ctx;
  const waveOf = new Map<string, number>();
  ev.waves.waves.forEach((w, i) => w.forEach((id) => waveOf.set(id, i)));
  const tasks: SpecTaskView[] = (ev.tasks?.topLevel ?? []).map((t) => {
    const st = state.tasks[t.id];
    const done = ev.isTaskDone(t.id);
    const next = ev.nextStep(t.id);
    const can = next === "blocked" ? ev.canStartTask(t.id) : null;
    return {
      id: t.id, title: t.title, line: t.line, optional: t.optional,
      status: done ? "done" : st?.status ?? "todo", done, next,
      blockedReason: can && !can.ok ? can.reason : null,
      wave: waveOf.get(t.id) ?? null,
      requirements: [...new Set([...t.requirements, ...t.children.flatMap((c) => c.requirements)])],
      deps: t.deps, files: t.allFiles, tests: t.allTests, noTest: t.noTest ?? null, screen: t.screen ?? null,
      children: t.children.map((c) => ({ id: c.id, title: c.title, done: c.done })),
      run: st ?? null,
    };
  });
  const phases = {} as SpecView["phases"];
  for (const p of ["requirements", "design", "tasks"] as SpecPhase[]) {
    phases[p] = { status: ev.phases[p].status, file: `${SPECS_DIR}/${state.slug}/${phaseFileName(state.kind, p)}`, issues: ev.phases[p].issues, text: docs[p],
      submitted: ev.phases[p].status === "draft" && !!ev.phases[p].hash && state.submitted?.[p] === ev.phases[p].hash };
  }
  const key = runKey(ctx.projectPath, state.slug);
  return {
    slug: state.slug, title: state.title, kind: state.kind, workflow: state.workflow, checks: state.checks,
    folder: `${SPECS_DIR}/${state.slug}`,
    current: ev.current, order: ev.order, phases,
    needsDrawing: ev.needsDrawing, drawing: ev.drawing, designSlug: state.designSlug ?? null,
    testCommand: ev.design?.testCommand ?? null,
    waves: ev.waves, tasks,
    approvals: state.approvals,
    baseline: state.baseline ?? null, baselineRunning: baselineRuns.has(key),
    suite: state.suite ?? null, suiteRunning: suiteRuns.has(key),
    run: state.run ?? null,
    runLive: runLiveFn(ctx.projectPath, state.slug),
    sessionId: state.sessionId ?? null,
    changeRequests: state.changeRequests ?? [],
    updatedAt: state.updatedAt,
  };
}

export async function getSpec(projectPath: string, slug: string): Promise<SpecView> {
  return toView(await loadSpec(projectPath, slug));
}

export async function listSpecs(projectPath: string): Promise<SpecSummary[]> {
  const out: SpecSummary[] = [];
  for (const slug of await listSpecSlugs(projectPath)) {
    try {
      const v = toView(await loadSpec(projectPath, slug));
      const required = v.tasks.filter((t) => !t.optional);
      out.push({
        slug, title: v.title, kind: v.kind, checks: v.checks, current: v.current,
        tasksDone: required.filter((t) => t.done).length, tasksTotal: required.length,
        red: v.tasks.filter((t) => t.status === "red").length,
        running: v.tasks.filter((t) => t.status === "running" || t.status === "red").length,
        waitingForYou: v.current !== "execution" && v.phases[v.current].submitted,
        sessionId: v.sessionId,
        updatedAt: v.updatedAt,
      });
    } catch (e) {
      log.debug(`skipping spec ${slug}: ${(e as Error).message}`);
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function changed(ctx: SpecContext): void {
  saveSpecState(ctx.projectPath, ctx.state);
  emitSpecEvent({ type: "spec:changed", projectPath: ctx.projectPath, slug: ctx.state.slug });
}

async function reload(ctx: SpecContext): Promise<SpecView> {
  return toView(await loadSpec(ctx.projectPath, ctx.state.slug));
}

// ─── creating and configuring ─────────────────────────────────────────────────

export interface CreateSpecInput {
  title: string;
  slug?: string;
  kind?: SpecKind;
  workflow?: SpecWorkflow;
  checks?: SpecChecks;
  sessionId?: string;
}

export async function createSpec(projectPath: string, input: CreateSpecInput): Promise<SpecView> {
  const title = input.title.trim().slice(0, 120);
  if (!title) throw new SpecError(400, "EBADTITLE", "A spec needs a title");
  let slug = input.slug && isValidSpecSlug(input.slug) ? input.slug : slugFromTitle(title) || "spec";
  const taken = new Set(await listSpecSlugs(projectPath));
  if (taken.has(slug)) {
    let n = 2;
    while (taken.has(`${slug}-${n}`)) n++;
    slug = `${slug}-${n}`.slice(0, 63);
  }
  const kind = input.kind ?? "feature";
  const workflow = kind === "bugfix" ? "requirements-first" : input.workflow ?? "requirements-first";
  const dir = await resolveSpecDir(projectPath, slug, { create: true });
  const first: SpecPhase = workflow === "design-first" ? "design" : "requirements";
  await writeSpecDoc(dir, kind, first, first === "design" ? designTemplate(title) : requirementsTemplate(title, kind));
  if (kind === "quick") {
    await writeSpecDoc(dir, kind, "design", designTemplate(title));
    await writeSpecDoc(dir, kind, "tasks", tasksTemplate(title));
  }
  const now = new Date().toISOString();
  const state: SpecState = {
    version: 1, slug, title, kind, workflow, checks: input.checks ?? "standard",
    createdAt: now, updatedAt: now, approvals: {}, tasks: {},
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };
  saveSpecState(projectPath, state);
  if (input.sessionId) bindSpecSession(input.sessionId, { projectPath, slug });
  emitSpecEvent({ type: "spec:changed", projectPath, slug });
  return getSpec(projectPath, slug);
}

/** Points a chat at a spec (the chat that drives it). */
export async function attachSession(projectPath: string, slug: string, sessionId: string): Promise<SpecView> {
  return withSpecLock(projectPath, slug, async () => {
    const ctx = await loadSpec(projectPath, slug);
    ctx.state.sessionId = sessionId;
    bindSpecSession(sessionId, { projectPath, slug });
    changed(ctx);
    return reload(ctx);
  });
}

export async function setChecks(projectPath: string, slug: string, checks: SpecChecks): Promise<SpecView> {
  return withSpecLock(projectPath, slug, async () => {
    const ctx = await loadSpec(projectPath, slug);
    if (ctx.state.checks === checks) return toView(ctx);
    ctx.state.checks = checks;
    changed(ctx);
    const view = await reload(ctx);
    // Switching to Thorough mid-way: the suite's failures right now are the baseline.
    if (checks === "thorough" && view.current === "execution" && !ctx.state.baseline && view.testCommand) {
      startBaseline(projectPath, slug, view.testCommand.suite);
    }
    return view;
  });
}

// ─── phases ───────────────────────────────────────────────────────────────────

export type GateResult = { ok: true; view: SpecView; message: string } | { ok: false; view: SpecView; message: string };

/** Checks a phase can go to the user; Quick specs are approved on the spot. */
export async function submitPhase(projectPath: string, slug: string, phase: SpecPhase): Promise<GateResult & { autoApproved?: boolean }> {
  const ctx = await loadSpec(projectPath, slug);
  const check = ctx.evaluation.canSubmit(phase);
  if (!check.ok) return { ok: false, view: toView(ctx), message: check.reason };
  const quick = ctx.state.kind === "quick";
  // Quick specs skip the stops — except the test command in Thorough, which PPM will execute.
  if (quick && !(phase === "design" && ctx.state.checks === "thorough")) {
    const approved = await approvePhase(projectPath, slug, phase);
    return { ...approved, autoApproved: approved.ok };
  }
  return withSpecLock(projectPath, slug, async () => {
    const fresh = await loadSpec(projectPath, slug);
    const hash = fresh.evaluation.phases[phase].hash;
    if (hash) (fresh.state.submitted ??= {})[phase] = hash;
    changed(fresh);
    return {
      ok: true, view: await reload(fresh),
      message: `${phase} is submitted: PPM shows it to the user. Stop here and wait — the approval or the requested changes arrive as the user's next message.`,
    };
  });
}

export async function approvePhase(projectPath: string, slug: string, phase: SpecPhase | "drawing"): Promise<GateResult> {
  return withSpecLock(projectPath, slug, async () => {
    const ctx = await loadSpec(projectPath, slug);
    const { evaluation: ev, state } = ctx;
    if (phase === "drawing") {
      if (!state.designSlug) return { ok: false, view: toView(ctx), message: "This spec has no drawing yet." };
      const hash = await drawingHashFn(projectPath, state.designSlug);
      if (!hash) return { ok: false, view: toView(ctx), message: "The drawing has no files yet." };
      state.approvals.drawing = { hash, at: new Date().toISOString() };
      changed(ctx);
      return { ok: true, view: await reload(ctx), message: "Drawing approved." };
    }
    const check = ev.canApprove(phase);
    if (!check.ok) return { ok: false, view: toView(ctx), message: check.reason };
    const approval: SpecState["approvals"][SpecPhase] = { hash: ev.phases[phase].hash!, at: new Date().toISOString() };
    if (phase === "tasks") approval.preDone = (ev.tasks?.topLevel ?? []).filter((t) => t.done).map((t) => t.id);
    state.approvals[phase] = approval;
    // The next document starts from its template, so the AI writes into Kiro's shape.
    const nextPhase = ev.order[ev.order.indexOf(phase) + 1];
    if (nextPhase && ctx.docs[nextPhase] === null) {
      const text = nextPhase === "design" ? designTemplate(state.title)
        : nextPhase === "tasks" ? tasksTemplate(state.title)
        : requirementsTemplate(state.title, state.kind);
      await writeSpecDoc(ctx.dir, state.kind, nextPhase, text);
    }
    changed(ctx);
    const view = await reload(ctx);
    if (phase === "tasks" && state.checks === "thorough" && view.testCommand && view.current === "execution") {
      startBaseline(projectPath, slug, view.testCommand.suite);
    }
    return { ok: true, view, message: `${phase} approved.` };
  });
}

export async function requestChanges(projectPath: string, slug: string, phase: SpecPhase | "drawing", note: string): Promise<SpecView> {
  return withSpecLock(projectPath, slug, async () => {
    const ctx = await loadSpec(projectPath, slug);
    const list = (ctx.state.changeRequests ??= []);
    list.push({ phase, note: note.slice(0, 4000), at: new Date().toISOString() });
    if (list.length > 20) list.splice(0, list.length - 20);
    changed(ctx);
    return reload(ctx);
  });
}

export async function setDesignSlug(projectPath: string, slug: string, designSlug: string): Promise<SpecView> {
  return withSpecLock(projectPath, slug, async () => {
    const ctx = await loadSpec(projectPath, slug);
    ctx.state.designSlug = designSlug;
    changed(ctx);
    return reload(ctx);
  });
}

// ─── baseline and suite ───────────────────────────────────────────────────────

const baselineWaiters = new Map<string, Promise<void>>();

function startBaseline(projectPath: string, slug: string, command: string): void {
  const key = runKey(projectPath, slug);
  if (baselineRuns.has(key)) return;
  baselineRuns.add(key);
  emitSpecEvent({ type: "spec:changed", projectPath, slug });
  const p = (async () => {
    try {
      const run = await runTestCommand(command, projectPath, DEFAULT_SUITE_TIMEOUT_MS);
      await withSpecLock(projectPath, slug, async () => {
        const ctx = await loadSpec(projectPath, slug);
        ctx.state.baseline = run.record;
        changed(ctx);
      });
    } catch (e) {
      log.warn(`baseline run for spec ${slug} failed: ${(e as Error).message}`);
    } finally {
      baselineRuns.delete(key);
      baselineWaiters.delete(key);
      emitSpecEvent({ type: "spec:changed", projectPath, slug });
    }
  })();
  baselineWaiters.set(key, p);
}

/** Waits for a baseline run in flight, if any. */
export async function baselineSettled(projectPath: string, slug: string): Promise<void> {
  await baselineWaiters.get(runKey(projectPath, slug));
}

/**
 * Runs the whole suite and compares it with the baseline. With tasks running beside each other
 * the suite is meaningful only once none is mid-edit, so callers run it when the last running
 * task of a wave has finished (the scheduler) or right after a lone task's green.
 */
export async function checkSuite(projectPath: string, slug: string): Promise<{ ok: boolean; message: string; view: SpecView }> {
  await baselineSettled(projectPath, slug);
  const key = runKey(projectPath, slug);
  const ctx0 = await loadSpec(projectPath, slug);
  const command = ctx0.evaluation.design?.testCommand?.suite;
  if (!command || !ctx0.state.approvals.design) return { ok: false, message: "There is no approved suite command.", view: toView(ctx0) };
  suiteRuns.add(key);
  emitSpecEvent({ type: "spec:changed", projectPath, slug });
  let run: TestRun;
  try {
    run = await runTestCommand(command, projectPath, DEFAULT_SUITE_TIMEOUT_MS);
  } finally {
    suiteRuns.delete(key);
  }
  return withSpecLock(projectPath, slug, async () => {
    const ctx = await loadSpec(projectPath, slug);
    const base = ctx.state.baseline;
    let fresh: string[];
    if (run.verdict.outcome === "pass") fresh = [];
    else if (run.verdict.outcome === "fail" && !run.verdict.weak) fresh = newFailures(run.verdict.failing, base?.failing ?? []);
    else if (run.verdict.outcome === "fail" && base && base.outcome === "fail") fresh = []; // exit-code-only runner that already failed before
    else fresh = [`the suite run was ${run.verdict.outcome}: ${run.verdict.reason}`];
    ctx.state.suite = { ...run.record, newFailures: fresh };
    if (ctx.state.run?.suiteBlocked && !fresh.length) delete ctx.state.run.suiteBlocked;
    changed(ctx);
    const view = await reload(ctx);
    return fresh.length
      ? { ok: false, view, message: `Whole suite: ${fresh.length} new failure${fresh.length > 1 ? "s" : ""} since the baseline — ${fresh.slice(0, 5).join("; ")}. Fix them, then check the suite again.` }
      : { ok: true, view, message: "Whole suite: no new failures." };
  });
}

// ─── tasks ────────────────────────────────────────────────────────────────────

const testPaths = (projectPath: string, files: string[]) => files.map((f) => ({ rel: f, abs: join(projectPath, f) }));

async function hashTests(projectPath: string, files: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const f of testPaths(projectPath, files)) out[f.rel] = await hashFile(f.abs);
  return out;
}

export async function startTask(projectPath: string, slug: string, id: string, opts: { sessionId?: string } = {}): Promise<GateResult> {
  return withSpecLock(projectPath, slug, async () => {
    const ctx = await loadSpec(projectPath, slug);
    const check = ctx.evaluation.canStartTask(id);
    if (!check.ok) return { ok: false, view: toView(ctx), message: check.reason };
    const t = ctx.evaluation.task(id)!;
    ctx.state.tasks[id] = {
      status: "running", startedAt: new Date().toISOString(),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      startHashes: await hashTests(projectPath, t.allTests),
    };
    if (opts.sessionId && opts.sessionId !== ctx.state.sessionId) bindSpecSession(opts.sessionId, { projectPath, slug, taskId: id });
    changed(ctx);
    const step = ctx.state.checks === "thorough" && !t.noTest
      ? `Write the failing tests first (${t.allTests.join(", ")}), then call task_red.`
      : "Implement it, then call task_done with a short summary.";
    return { ok: true, view: await reload(ctx), message: `Task ${id} started. ${step}` };
  });
}

async function tick(ctx: SpecContext, id: string, done: boolean): Promise<void> {
  const t = ctx.evaluation.task(id);
  if (!t || t.heading || ctx.docs.tasks === null) return;
  const next = setTaskChecked(ctx.docs.tasks, t.line, done);
  if (next !== ctx.docs.tasks) await writeSpecDoc(ctx.dir, ctx.state.kind, "tasks", next);
}

export async function taskDone(projectPath: string, slug: string, id: string, summary: string): Promise<GateResult> {
  return withSpecLock(projectPath, slug, async () => {
    const ctx = await loadSpec(projectPath, slug);
    const step = ctx.evaluation.nextStep(id);
    if (step !== "done") {
      const msg = step === "red" ? "This spec is Thorough: call task_red once the task's tests fail, then task_green."
        : step === "green" ? "Call task_green: PPM runs the tests and finishes the task when they pass."
        : step === "finished" ? `Task ${id} is already done.`
        : `Task ${id} is not running; call task_start first.`;
      return { ok: false, view: toView(ctx), message: msg };
    }
    const st = ctx.state.tasks[id]!;
    Object.assign(st, { status: "done", summary: summary.slice(0, 2000), finishedAt: new Date().toISOString() } satisfies Partial<SpecTaskState>);
    await tick(ctx, id, true);
    changed(ctx);
    return { ok: true, view: await reload(ctx), message: `Task ${id} done.` };
  });
}

function runSummary(run: TestRun): string {
  const v = run.verdict;
  const counts = v.failed !== null || v.passed !== null ? ` (${v.failed ?? 0} failing, ${v.passed ?? 0} passing)` : "";
  const names = v.failing.length ? `\nFailing: ${v.failing.slice(0, 8).join("; ")}` : "";
  const tail = run.record.output.split("\n").slice(-25).join("\n");
  return `${v.outcome}${counts} — ${v.reason}${names}\n--- last lines ---\n${tail}`;
}

export async function taskRed(projectPath: string, slug: string, id: string): Promise<GateResult> {
  const pre = await loadSpec(projectPath, slug);
  if (pre.evaluation.nextStep(id) !== "red") {
    return { ok: false, view: toView(pre), message: pre.state.checks !== "thorough" ? "This spec is Standard: there is no red step; call task_done." : `Task ${id} is not waiting for its red check.` };
  }
  const t = pre.evaluation.task(id)!;
  const now = await hashTests(projectPath, t.allTests);
  const missing = t.allTests.filter((f) => !now[f]);
  if (missing.length) return { ok: false, view: toView(pre), message: `Write the test file${missing.length > 1 ? "s" : ""} first: ${missing.join(", ")}.` };
  const start = pre.state.tasks[id]?.startHashes ?? {};
  if (!t.allTests.some((f) => now[f] !== (start[f] ?? null))) {
    return { ok: false, view: toView(pre), message: `None of ${t.allTests.join(", ")} changed since the task started: write the new tests for this task first.` };
  }
  const command = expandTestCommand(pre.evaluation.design!.testCommand!.task, t.allTests);
  const run = await runTestCommand(command, projectPath, DEFAULT_TASK_TIMEOUT_MS);
  return withSpecLock(projectPath, slug, async () => {
    const ctx = await loadSpec(projectPath, slug);
    const st = ctx.state.tasks[id];
    if (!st || st.status !== "running") return { ok: false, view: toView(ctx), message: `Task ${id} changed state while its tests ran.` };
    if (run.verdict.outcome === "fail") {
      Object.assign(st, { status: "red", red: run.record, lockedHashes: await hashTests(projectPath, t.allTests) as Record<string, string>, lastRun: undefined });
      changed(ctx);
      return { ok: true, view: await reload(ctx), message: `Red: ${runSummary(run)}\nThe test files are now locked. Write the code, then call task_green.` };
    }
    st.lastRun = run.record;
    changed(ctx);
    const why = run.verdict.outcome === "pass" ? "the tests already pass — they must fail before the code exists."
      : run.verdict.outcome === "broken" ? "the tests did not run (a load, import or compile error is not a red). Make them load and fail on an assertion."
      : run.verdict.outcome === "empty" ? "no test ran: check the _Test:_ files and the test command."
      : "the run hit its time limit.";
    return { ok: false, view: await reload(ctx), message: `Not a valid red: ${why}\n${runSummary(run)}` };
  });
}

export async function taskGreen(projectPath: string, slug: string, id: string): Promise<GateResult & { suite?: string }> {
  const pre = await loadSpec(projectPath, slug);
  if (pre.evaluation.nextStep(id) !== "green") {
    return { ok: false, view: toView(pre), message: pre.state.tasks[id]?.status === "running" ? "Call task_red first: the tests must fail before the code is written." : `Task ${id} is not waiting for its green check.` };
  }
  const t = pre.evaluation.task(id)!;
  const locked = pre.state.tasks[id]?.lockedHashes ?? {};
  const now = await hashTests(projectPath, t.allTests);
  const edited = t.allTests.filter((f) => now[f] !== locked[f]);
  if (edited.length) {
    return { ok: false, view: toView(pre), message: `Refused: ${edited.join(", ")} changed after the red check. Put the test back as it was (the code must change, not the test), or ask the user to restart the task.` };
  }
  const command = expandTestCommand(pre.evaluation.design!.testCommand!.task, t.allTests);
  const run = await runTestCommand(command, projectPath, DEFAULT_TASK_TIMEOUT_MS);
  const result = await withSpecLock(projectPath, slug, async () => {
    const ctx = await loadSpec(projectPath, slug);
    const st = ctx.state.tasks[id];
    if (!st || st.status !== "red") return { ok: false as const, view: toView(ctx), message: `Task ${id} changed state while its tests ran.` };
    if (run.verdict.outcome !== "pass") {
      st.lastRun = run.record;
      changed(ctx);
      return { ok: false as const, view: await reload(ctx), message: `Not green yet: ${runSummary(run)}` };
    }
    Object.assign(st, { status: "done", green: run.record, lastRun: undefined, finishedAt: new Date().toISOString() });
    await tick(ctx, id, true);
    changed(ctx);
    const others = Object.entries(ctx.state.tasks).some(([k, v]) => k !== id && (v.status === "running" || v.status === "red"));
    return { ok: true as const, view: await reload(ctx), message: `Green: task ${id} done.`, deferSuite: others };
  });
  if (!result.ok) return result;
  // Alone: check the whole suite now. Beside other tasks: the scheduler checks it once the wave ends.
  if ("deferSuite" in result && result.deferSuite) {
    return { ok: true, view: result.view, message: `${result.message} The whole suite is checked when the tasks running beside it finish.` };
  }
  const suite = await checkSuite(projectPath, slug);
  return { ok: true, view: suite.view, message: `${result.message} ${suite.message}`, suite: suite.message };
}

/** Puts a task back to not started (Stop, or the user restarting it). Test locks are dropped. */
export async function resetTask(projectPath: string, slug: string, id: string, status: "todo" | "failed" = "todo", error?: string): Promise<SpecView> {
  return withSpecLock(projectPath, slug, async () => {
    const ctx = await loadSpec(projectPath, slug);
    const st = ctx.state.tasks[id];
    if (!st) return toView(ctx);
    if (status === "todo") delete ctx.state.tasks[id];
    else Object.assign(st, { status, error });
    changed(ctx);
    return reload(ctx);
  });
}

export async function setRunState(projectPath: string, slug: string, run: SpecState["run"] | null): Promise<SpecView> {
  return withSpecLock(projectPath, slug, async () => {
    const ctx = await loadSpec(projectPath, slug);
    if (run) ctx.state.run = run;
    else delete ctx.state.run;
    changed(ctx);
    return reload(ctx);
  });
}
