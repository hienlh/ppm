/**
 * Spec mode — shared shapes between the server, the browser and the CLI.
 *
 * A spec is three Markdown files in `specs/<slug>/` (written by the AI and by people) plus a
 * state file PPM keeps in its own directory (approvals, task runs, the wave plan's progress),
 * which no AI tool writes. See `docs/architecture/ai-chat-and-providers.md` → Spec mode.
 */

export type SpecKind = "feature" | "bugfix" | "quick";
export type SpecWorkflow = "requirements-first" | "design-first";
/** Standard: the AI marks a task done. Thorough: PPM runs the tests, red then green. */
export type SpecChecks = "standard" | "thorough";
export type SpecPhase = "requirements" | "design" | "tasks";
export type PhaseStatus = "missing" | "invalid" | "draft" | "approved" | "stale";
export type TaskStatus = "todo" | "running" | "red" | "done" | "failed";

export const SPEC_KINDS: readonly SpecKind[] = ["feature", "bugfix", "quick"];
export const SPEC_CHECKS: readonly SpecChecks[] = ["standard", "thorough"];
export const SPEC_WORKFLOWS: readonly SpecWorkflow[] = ["requirements-first", "design-first"];
export const SPEC_PHASES: readonly SpecPhase[] = ["requirements", "design", "tasks"];

export const SPECS_DIR = "specs";

/** The requirements-phase document: `bugfix.md` for a bug fix, `requirements.md` otherwise. */
export function requirementsFileName(kind: SpecKind): string {
  return kind === "bugfix" ? "bugfix.md" : "requirements.md";
}

export function phaseFileName(kind: SpecKind, phase: SpecPhase): string {
  return phase === "requirements" ? requirementsFileName(kind) : `${phase}.md`;
}

export interface SpecApproval {
  /** sha256 of the document (or of the drawing's files) at the moment it was approved. */
  hash: string;
  at: string;
  /** tasks only: tasks whose box was already ticked in the approved tasks.md. */
  preDone?: string[];
}

/** What one test run looked like, as judged by `test-judge.ts`. */
export interface SpecRunRecord {
  at: string;
  command: string;
  outcome: "pass" | "fail" | "broken" | "empty" | "timeout";
  failing: string[];
  passed: number | null;
  failed: number | null;
  weak: boolean;
  /** Head and tail of the output, capped. */
  output: string;
  durationMs: number;
}

export interface SpecTaskState {
  status: TaskStatus;
  /** The chat session running this task (the spec chat itself, or a child of it). */
  sessionId?: string;
  startedAt?: string;
  /** sha256 of each of the task's test files when it started (null: did not exist). */
  startHashes?: Record<string, string | null>;
  /** sha256 of each test file at the valid red run: green refuses if any changed. */
  lockedHashes?: Record<string, string>;
  red?: SpecRunRecord;
  green?: SpecRunRecord;
  /** The last run that did not pass a gate, so the UI can show why. */
  lastRun?: SpecRunRecord;
  summary?: string;
  error?: string;
  finishedAt?: string;
}

export interface SpecRunState {
  active: boolean;
  startedAt: string;
  /** Index into the wave plan of the wave running now. */
  wave: number;
  stoppedAt?: string;
  /** Set when the whole suite showed new failures after a wave: the run waits on it. */
  suiteBlocked?: { wave: number; failing: string[]; at: string };
}

export interface SpecState {
  version: 1;
  slug: string;
  title: string;
  kind: SpecKind;
  workflow: SpecWorkflow;
  checks: SpecChecks;
  createdAt: string;
  updatedAt: string;
  /** The chat the spec is driven from. */
  sessionId?: string;
  /** Slug of the PPM Design drawn for this spec, when its requirements say `UI: yes`. */
  designSlug?: string;
  approvals: Partial<Record<SpecPhase | "drawing", SpecApproval>>;
  /** Failures the whole suite already had when tasks were approved (Thorough). */
  baseline?: SpecRunRecord;
  /** Set after a whole-suite run with new failures, until a clean run clears it. */
  suite?: SpecRunRecord & { newFailures: string[] };
  tasks: Record<string, SpecTaskState>;
  run?: SpecRunState;
  /** Notes the user sent with Request changes, newest last (kept for the AI's context). */
  changeRequests?: { phase: SpecPhase | "drawing"; note: string; at: string }[];
  /** The document hash the AI last submitted per phase: equal to the file's now = waiting for review. */
  submitted?: Partial<Record<SpecPhase, string>>;
}

export function emptySpecState(init: Pick<SpecState, "slug" | "title" | "kind" | "workflow" | "checks">): SpecState {
  const now = new Date().toISOString();
  return { version: 1, ...init, createdAt: now, updatedAt: now, approvals: {}, tasks: {} };
}

/** One line of a summary list (sidebar, CLI). */
export interface SpecSummary {
  slug: string;
  title: string;
  kind: SpecKind;
  checks: SpecChecks;
  current: SpecPhase | "execution";
  tasksDone: number;
  tasksTotal: number;
  red: number;
  running: number;
  waitingForYou: boolean;
  /** The chat that drives it, when it has one. */
  sessionId: string | null;
  updatedAt: string;
}

export const isSpecKind = (v: unknown): v is SpecKind => (SPEC_KINDS as readonly unknown[]).includes(v);
export const isSpecChecks = (v: unknown): v is SpecChecks => (SPEC_CHECKS as readonly unknown[]).includes(v);
export const isSpecWorkflow = (v: unknown): v is SpecWorkflow => (SPEC_WORKFLOWS as readonly unknown[]).includes(v);
export const isSpecPhase = (v: unknown): v is SpecPhase => (SPEC_PHASES as readonly unknown[]).includes(v);

/** Same rule as design slugs: one safe path segment. */
export const SPEC_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const isValidSpecSlug = (v: unknown): v is string => typeof v === "string" && SPEC_SLUG_RE.test(v);
