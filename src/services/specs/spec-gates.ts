/**
 * The rules of a spec, as one pure function of its documents and PPM's state.
 *
 * Everything that decides "may this happen now" lives here — the MCP tools, the REST routes,
 * the scheduler and the browser's buttons all ask the same answers, so an AI on any provider
 * meets the same gates a person clicking does. No I/O: callers read the files and the state.
 */
import { createHash } from "node:crypto";
import {
  firstError, hasErrors, parseDesign, parseRequirements, parseTasks,
  type DesignDoc, type RequirementsDoc, type SpecIssue, type SpecWorkItem, type TasksDoc,
} from "../../shared/spec-format.ts";
import { planWaves, sharedFiles, type WavePlan } from "../../shared/spec-waves.ts";
import type { PhaseStatus, SpecPhase, SpecState } from "../../shared/spec-types.ts";

export interface GateDocs {
  requirements: string | null;
  design: string | null;
  tasks: string | null;
}

export interface GateExtras {
  /** Content hash of the spec's PPM Design right now, when one exists. */
  drawingHash?: string | null;
}

export interface PhaseView {
  status: PhaseStatus;
  hash: string | null;
  issues: SpecIssue[];
}

export type Check = { ok: true; reason?: undefined } | { ok: false; reason: string };
import type { DrawingStatus, NextStep } from "../../shared/spec-view.ts";
export type { NextStep } from "../../shared/spec-view.ts";

export interface SpecEvaluation {
  order: SpecPhase[];
  phases: Record<SpecPhase, PhaseView>;
  /** The first phase not approved, or "execution" once all three are. */
  current: SpecPhase | "execution";
  requirements: RequirementsDoc | null;
  design: DesignDoc | null;
  tasks: TasksDoc | null;
  waves: WavePlan;
  /** UI: yes in the requirements. */
  needsDrawing: boolean;
  drawing: DrawingStatus;
  canSubmit(phase: SpecPhase): Check;
  canApprove(phase: SpecPhase): Check;
  canStartTask(id: string): Check;
  nextStep(id: string): NextStep;
  isTaskDone(id: string): boolean;
  task(id: string): SpecWorkItem | undefined;
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * The hash a phase is approved under. For tasks.md the boxes are cleared first: PPM ticks a
 * box when a task finishes, and that must not reopen the approved plan.
 */
export function phaseHash(phase: SpecPhase, text: string): string {
  return sha256(phase === "tasks" ? text.replace(/^(\s*[-*]\s+\[)[xX](\])/gm, "$1 $2") : text);
}

const ok: Check = { ok: true };
const no = (reason: string): Check => ({ ok: false, reason });

export function phaseOrder(state: SpecState): SpecPhase[] {
  return state.workflow === "design-first" ? ["design", "requirements", "tasks"] : ["requirements", "design", "tasks"];
}

export function evaluateSpec(docs: GateDocs, state: SpecState, extras: GateExtras = {}): SpecEvaluation {
  const reqKind = state.kind === "bugfix" ? "bugfix" : "feature";
  const requirements = docs.requirements === null ? null : parseRequirements(docs.requirements, reqKind);
  const design = docs.design === null ? null : parseDesign(docs.design);
  const tasks = docs.tasks === null ? null : parseTasks(docs.tasks, requirements ?? undefined);
  const waves = tasks ? planWaves(tasks.topLevel) : { waves: [], moved: [], optional: [], issues: [] };
  const thorough = state.checks === "thorough";

  const issuesOf: Record<SpecPhase, SpecIssue[]> = {
    requirements: requirements?.issues ?? [],
    design: design?.issues ?? [],
    tasks: [...(tasks?.issues ?? []), ...waves.issues],
  };
  const phases = {} as Record<SpecPhase, PhaseView>;
  for (const p of ["requirements", "design", "tasks"] as SpecPhase[]) {
    const text = docs[p];
    if (text === null) { phases[p] = { status: "missing", hash: null, issues: [] }; continue; }
    const hash = phaseHash(p, text);
    const approval = state.approvals[p];
    const status: PhaseStatus = hasErrors(issuesOf[p]) ? "invalid"
      : approval ? (approval.hash === hash ? "approved" : "stale") : "draft";
    phases[p] = { status, hash, issues: issuesOf[p] };
  }

  const needsDrawing = requirements?.ui === true;
  const drawingApproval = state.approvals.drawing;
  const drawing: SpecEvaluation["drawing"] = !needsDrawing ? "not-needed"
    : !extras.drawingHash && !drawingApproval ? "missing"
    : !drawingApproval ? "draft"
    : extras.drawingHash === undefined || extras.drawingHash === drawingApproval.hash ? "approved" : "stale";

  const order = phaseOrder(state);
  // A phase counts only while every phase before it is approved too.
  // The design counts only with its drawing approved too, so a drawing changed afterwards reopens it.
  const effective = (p: SpecPhase): boolean => {
    for (const q of order) {
      if (phases[q].status !== "approved") return false;
      if (q === "design" && needsDrawing && drawing !== "approved") return false;
      if (q === p) return true;
    }
    return false;
  };
  const current: SpecEvaluation["current"] = order.find((p) => !effective(p)) ?? "execution";

  const topLevel = tasks?.topLevel ?? [];
  const task = (id: string) => topLevel.find((t) => t.id === id);
  // In Thorough only PPM finishes a task (after green): a box the AI ticked itself counts only
  // if it was already ticked in the tasks.md you approved. In Standard a ticked box is done.
  const preDone = new Set(state.approvals.tasks?.preDone ?? []);
  const isTaskDone = (id: string): boolean => {
    const st = state.tasks[id]?.status;
    if (st === "done") return true;
    if (st === "running" || st === "red") return false;
    if (!task(id)?.done) return false;
    return !thorough || preDone.has(id);
  };

  const prerequisites = (phase: SpecPhase): Check => {
    for (const q of order) {
      if (q === phase) return ok;
      if (!effective(q)) return no(`Approve ${q} first (it is ${phases[q].status}).`);
    }
    return ok;
  };

  const thoroughTaskCheck = (): Check => {
    if (!thorough) return ok;
    const missing = topLevel.filter((t) => !t.optional && !t.done && t.allTests.length === 0 && !t.noTest);
    if (missing.length) {
      return no(`Thorough: task${missing.length > 1 ? "s" : ""} ${missing.map((t) => t.id).join(", ")} need a _Test:_ line (or _Test: none — reason_).`);
    }
    return ok;
  };

  const canSubmit = (phase: SpecPhase): Check => {
    const pre = prerequisites(phase);
    if (!pre.ok) return pre;
    const view = phases[phase];
    if (view.status === "missing") return no(`Write ${phase === "requirements" ? (state.kind === "bugfix" ? "bugfix.md" : "requirements.md") : `${phase}.md`} first.`);
    if (view.status === "invalid") return no(`Fix ${phase} first — ${firstError(view.issues)}`);
    if (phase === "tasks") return thoroughTaskCheck();
    return ok;
  };

  const canApprove = (phase: SpecPhase): Check => {
    const sub = canSubmit(phase);
    if (!sub.ok) return sub;
    if (phase === "design") {
      if (thorough && !design?.testCommand) return no("Thorough needs a test command: add a ```ppm-test block (task: …{files}…, suite: …) to design.md.");
      if (needsDrawing && drawing !== "approved") return no(drawing === "stale" ? "The drawing changed since it was approved; approve it again." : "Approve the UI drawing first (UI: yes).");
    }
    return ok;
  };

  const canStartTask = (id: string): Check => {
    if (current !== "execution") return no(`Tasks start once every phase is approved; ${current} is not.`);
    const t = task(id);
    if (!t) return no(`There is no top-level task ${id}.`);
    if (isTaskDone(id)) return no(`Task ${id} is already done.`);
    const st = state.tasks[id]?.status;
    if (st === "running" || st === "red") return no(`Task ${id} is already running.`);
    if (state.suite?.newFailures.length) {
      return no(`The whole suite has new failures (${state.suite.newFailures.slice(0, 3).join(", ")}); fix them and check the suite again first.`);
    }
    const waiting = t.deps.filter((d) => !isTaskDone(d));
    if (waiting.length) return no(`Task ${id} waits on task ${waiting.join(", ")}.`);
    const running = topLevel.filter((o) => o.id !== id && (state.tasks[o.id]?.status === "running" || state.tasks[o.id]?.status === "red"));
    for (const o of running) {
      if (o.allFiles.length === 0) return no(`Task ${o.id} is running and declares no files, so nothing else may run beside it.`);
      if (t.allFiles.length === 0) return no(`Task ${id} declares no files, so it must run alone; task ${o.id} is running.`);
      const shared = sharedFiles(t.allFiles, o.allFiles);
      if (shared.length) return no(`Task ${o.id} is running and also touches ${shared.join(", ")}.`);
    }
    return ok;
  };

  const nextStep = (id: string): NextStep => {
    const t = task(id);
    if (!t) return "blocked";
    if (isTaskDone(id)) return "finished";
    const st = state.tasks[id]?.status;
    if (st === "running") return thorough && !t.noTest ? "red" : "done";
    if (st === "red") return "green";
    return canStartTask(id).ok ? "start" : "blocked";
  };

  return { order, phases, current, requirements, design, tasks, waves, needsDrawing, drawing, canSubmit, canApprove, canStartTask, nextStep, isTaskDone, task };
}
