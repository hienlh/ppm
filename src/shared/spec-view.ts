/**
 * What the server answers about a spec (`GET /api/project/:name/specs/:slug`): its documents'
 * states, the tasks with their waves and next steps, the test runs. Built by `spec.service.ts`;
 * shared so the browser and `ppm spec` read the same shape.
 */
import type { SpecIssue } from "./spec-format.ts";
import type { WavePlan } from "./spec-waves.ts";
import type {
  PhaseStatus, SpecChecks, SpecKind, SpecPhase, SpecRunRecord, SpecState, SpecTaskState, SpecWorkflow, TaskStatus,
} from "./spec-types.ts";

/** What a task can do next: start it, finish it (Standard), its red or green run, or nothing yet. */
export type NextStep = "start" | "done" | "red" | "green" | "finished" | "blocked";
export type DrawingStatus = "not-needed" | "missing" | "draft" | "approved" | "stale";

export interface SpecTaskView {
  id: string;
  title: string;
  line: number;
  optional: boolean;
  status: TaskStatus;
  done: boolean;
  next: NextStep;
  blockedReason: string | null;
  wave: number | null;
  requirements: string[];
  deps: string[];
  files: string[];
  tests: string[];
  noTest: string | null;
  screen: string | null;
  children: { id: string; title: string; done: boolean }[];
  run: SpecTaskState | null;
}

export interface SpecView {
  slug: string;
  title: string;
  kind: SpecKind;
  workflow: SpecWorkflow;
  checks: SpecChecks;
  folder: string;
  current: SpecPhase | "execution";
  order: SpecPhase[];
  phases: Record<SpecPhase, { status: PhaseStatus; file: string; issues: SpecIssue[]; text: string | null; submitted: boolean }>;
  needsDrawing: boolean;
  drawing: DrawingStatus;
  designSlug: string | null;
  testCommand: { task: string; suite: string } | null;
  waves: WavePlan;
  tasks: SpecTaskView[];
  approvals: SpecState["approvals"];
  baseline: SpecRunRecord | null;
  baselineRunning: boolean;
  suite: SpecState["suite"] | null;
  suiteRunning: boolean;
  run: SpecState["run"] | null;
  /** A run marked active that this process is driving; false after a restart interrupted it. */
  runLive: boolean;
  sessionId: string | null;
  changeRequests: NonNullable<SpecState["changeRequests"]>;
  updatedAt: string;
}
