/**
 * Parsers for the three spec documents, in Kiro's formats.
 *
 * - `requirements.md`: `### Requirement N: Title`, an optional `**User Story:**`, then numbered
 *   EARS acceptance criteria. Criterion k of requirement N is `N.k` — the id tasks cite.
 * - `bugfix.md`: `## Current Behavior`, `## Expected Behavior`, `## Unchanged Behavior`, each a
 *   numbered list; their ids are `1.k`, `2.k` and `3.k`.
 * - `design.md`: free text plus one fenced `ppm-test` block naming the test commands.
 * - `tasks.md`: `- [ ] N. Title` checkboxes (sub-tasks `- [ ] N.k`, optional `- [ ]* N.`, or
 *   Kiro's `## Task N: Title` heading), each followed by `_Key: value_` annotation lines.
 *
 * Every problem is reported with a 1-based line and a sentence an AI can act on, because the
 * tools hand these back to the AI that wrote the file.
 */
import type { SpecKind } from "./spec-types.ts";

export interface SpecIssue {
  line: number;
  severity: "error" | "warning";
  message: string;
}

export interface Criterion {
  id: string;
  text: string;
  line: number;
  section?: "current" | "expected" | "unchanged";
}

export interface Requirement {
  n: number;
  title: string;
  story?: string;
  line: number;
  criteria: Criterion[];
}

export interface RequirementsDoc {
  title: string | null;
  /** `UI: yes|no` anywhere in the document; null when it says neither. */
  ui: boolean | null;
  requirements: Requirement[];
  criteria: Criterion[];
  issues: SpecIssue[];
}

export interface SpecTask {
  id: string;
  title: string;
  /** 1-based line of the checkbox (or heading) in tasks.md. */
  line: number;
  done: boolean;
  optional: boolean;
  /** Id of the top-level task this one belongs to. */
  parent?: string;
  requirements: string[];
  deps: string[];
  files: string[];
  tests: string[];
  /** Set when the task says `_Test: none — reason_`: the reason. */
  noTest?: string;
  screen?: string;
  details: string[];
  /** Heading-form tasks (`## Task N:`) have no box of their own. */
  heading?: boolean;
}

/** A top-level task with its sub-tasks folded in: the unit PPM schedules and runs. */
export interface SpecWorkItem extends SpecTask {
  children: SpecTask[];
  allFiles: string[];
  allTests: string[];
}

export interface TasksDoc {
  tasks: SpecTask[];
  topLevel: SpecWorkItem[];
  issues: SpecIssue[];
}

export interface TestCommand {
  /** Runs one task's tests; `{files}` is replaced by the task's test files. */
  task: string;
  /** Runs the whole suite. */
  suite: string;
}

export interface DesignDoc {
  testCommand: TestCommand | null;
  issues: SpecIssue[];
}

const lines = (text: string): string[] => text.split(/\r?\n/);
const stripMd = (s: string): string => s.replace(/\*\*/g, "").replace(/^_+|_+$/g, "").trim();
const listOf = (value: string): string[] =>
  value.split(/[,;]/).map((v) => v.trim().replace(/^`|`$/g, "")).filter(Boolean);

// ─── requirements ─────────────────────────────────────────────────────────────

const REQ_HEADING = /^#{2,4}\s+Requirement\s+(\d+)\s*[:.\-–—]?\s*(.*)$/i;
const BUGFIX_SECTIONS: [RegExp, NonNullable<Criterion["section"]>][] = [
  [/^#{2,3}\s+Current\s+Behaviou?r/i, "current"],
  [/^#{2,3}\s+Expected\s+Behaviou?r/i, "expected"],
  [/^#{2,3}\s+Unchanged\s+Behaviou?r/i, "unchanged"],
];
const NUMBERED = /^\s*(\d+)[.)]\s+(.+)$/;
const UI_LINE = /^\s*[-*]?\s*\**UI\**\s*:?\**\s*(yes|no)\b/i;
const STORY = /^\s*\**User\s+Story:?\**\s*:?\s*(.+)$/i;

export function parseRequirements(text: string, kind: SpecKind): RequirementsDoc {
  const ls = lines(text);
  const issues: SpecIssue[] = [];
  const requirements: Requirement[] = [];
  let title: string | null = null;
  let ui: boolean | null = null;
  let current: Requirement | null = null;
  let inCriteria = kind === "bugfix";

  ls.forEach((raw, i) => {
    const line = i + 1;
    const uiMatch = raw.match(UI_LINE);
    if (uiMatch) {
      ui = uiMatch[1]!.toLowerCase() === "yes";
      return;
    }
    if (!title) {
      const h1 = raw.match(/^#\s+(.+)$/);
      if (h1) title = h1[1]!.trim();
    }
    if (kind === "bugfix") {
      const section = BUGFIX_SECTIONS.findIndex(([re]) => re.test(raw));
      if (section >= 0) {
        current = { n: section + 1, title: BUGFIX_SECTIONS[section]![1], line, criteria: [] };
        requirements.push(current);
        return;
      }
    } else {
      const h = raw.match(REQ_HEADING);
      if (h) {
        current = { n: Number(h[1]), title: h[2]!.trim(), line, criteria: [] };
        if (requirements.some((r) => r.n === current!.n)) {
          issues.push({ line, severity: "error", message: `Requirement ${current.n} appears twice; number requirements 1, 2, 3…` });
        }
        requirements.push(current);
        inCriteria = false;
        return;
      }
      if (/^#{2,5}\s+/.test(raw)) {
        inCriteria = /acceptance\s+criteria/i.test(raw);
        if (!inCriteria && /^#{2}\s+/.test(raw)) current = null;
        return;
      }
      const story = raw.match(STORY);
      if (story && current) {
        current.story = stripMd(story[1]!);
        return;
      }
    }
    const item = raw.match(NUMBERED);
    if (item && current && inCriteria) {
      const k = current.criteria.length + 1;
      const crit: Criterion = { id: `${current.n}.${k}`, text: item[2]!.trim(), line };
      if (kind === "bugfix") crit.section = BUGFIX_SECTIONS[current.n - 1]![1];
      else if (!/\bSHALL\b/i.test(crit.text)) {
        issues.push({ line, severity: "warning", message: `Criterion ${crit.id} is not in EARS form ("WHEN … THE SYSTEM SHALL …").` });
      }
      current.criteria.push(crit);
    }
  });

  const criteria = requirements.flatMap((r) => r.criteria);
  if (kind === "bugfix") {
    for (const [, name] of BUGFIX_SECTIONS) {
      const sec = requirements.find((r) => r.title === name);
      if (!sec) issues.push({ line: 1, severity: "error", message: `bugfix.md needs a "## ${name[0]!.toUpperCase()}${name.slice(1)} Behavior" section.` });
      else if (sec.criteria.length === 0 && name !== "unchanged") {
        issues.push({ line: sec.line, severity: "error", message: `The ${name} behavior section has no numbered items.` });
      }
    }
  } else {
    if (requirements.length === 0) {
      issues.push({ line: 1, severity: "error", message: 'No requirements found: write "### Requirement 1: Title" headings with numbered acceptance criteria.' });
    }
    for (const r of requirements) {
      if (r.criteria.length === 0) {
        issues.push({ line: r.line, severity: "error", message: `Requirement ${r.n} has no numbered acceptance criteria under "#### Acceptance Criteria".` });
      }
    }
  }
  return { title, ui, requirements, criteria, issues };
}

// ─── tasks ────────────────────────────────────────────────────────────────────

const CHECKBOX = /^(\s*)[-*]\s+\[( |x|X)\](\*?)\s+(\d+(?:\.\d+)*)\.?\s+(.*)$/;
const TASK_HEADING = /^#{2,3}\s+Task\s+(\d+)\s*[:.\-–—]\s*(.+)$/i;
const ANNOTATION = /^\s*[-*]?\s*(?:_|\*\*)\s*([A-Za-z ]+?)\s*:\s*(.*?)\s*(?:_|\*\*)\s*$/;

function applyAnnotation(task: SpecTask, key: string, value: string, line: number, issues: SpecIssue[]): boolean {
  const k = key.toLowerCase().trim();
  if (k === "requirements" || k === "validates" || k === "requirement") {
    task.requirements.push(...listOf(value.replace(/^requirements?\s*/i, "")));
  } else if (k === "deps" || k === "depends on" || k === "depends") {
    task.deps.push(...listOf(value).map((d) => d.replace(/^task\s+/i, "")));
  } else if (k === "files" || k === "file") {
    task.files.push(...listOf(value));
  } else if (k === "test" || k === "tests") {
    if (/^none\b/i.test(value)) {
      const reason = value.replace(/^none\s*[-–—:,]?\s*/i, "").trim();
      task.noTest = reason || "no reason given";
      if (!reason) issues.push({ line, severity: "warning", message: `Task ${task.id}: say why it has no test (_Test: none — reason_).` });
    } else task.tests.push(...listOf(value));
  } else if (k === "screen") {
    task.screen = value.trim();
  } else return false;
  return true;
}

export function parseTasks(text: string, requirements?: RequirementsDoc): TasksDoc {
  const ls = lines(text);
  const tasks: SpecTask[] = [];
  const issues: SpecIssue[] = [];
  let last: SpecTask | null = null;
  let headingTask: SpecTask | null = null;

  ls.forEach((raw, i) => {
    const line = i + 1;
    const head = raw.match(TASK_HEADING);
    if (head) {
      const t: SpecTask = { id: head[1]!, title: head[2]!.trim(), line, done: false, optional: false, requirements: [], deps: [], files: [], tests: [], details: [], heading: true };
      tasks.push(t);
      last = t;
      headingTask = t;
      return;
    }
    const box = raw.match(CHECKBOX);
    if (box) {
      const id = box[4]!;
      const parts = id.split(".");
      const t: SpecTask = {
        id, title: box[5]!.trim(), line, done: box[2] !== " ", optional: box[3] === "*",
        requirements: [], deps: [], files: [], tests: [], details: [],
      };
      if (parts.length > 1) t.parent = parts[0]!;
      else headingTask = null;
      if (parts.length > 1 && headingTask && headingTask.id !== parts[0]) {
        issues.push({ line, severity: "error", message: `Sub-task ${id} sits under Task ${headingTask.id}; number it ${headingTask.id}.${parts[parts.length - 1]}.` });
      }
      tasks.push(t);
      last = t;
      return;
    }
    if (!last) return;
    const ann = raw.match(ANNOTATION);
    if (ann && applyAnnotation(last, ann[1]!, ann[2]!, line, issues)) return;
    const detail = raw.match(/^\s+[-*]\s+(.+)$/);
    if (detail) last.details.push(detail[1]!.trim());
  });

  // Ids are unique; sub-tasks need a parent.
  const byId = new Map<string, SpecTask>();
  for (const t of tasks) {
    if (byId.has(t.id)) issues.push({ line: t.line, severity: "error", message: `Task ${t.id} appears twice; every task needs its own number.` });
    byId.set(t.id, t);
  }
  for (const t of tasks) {
    if (t.parent && !byId.has(t.parent)) {
      issues.push({ line: t.line, severity: "error", message: `Sub-task ${t.id} has no task ${t.parent} above it.` });
    }
  }

  const topLevel: SpecWorkItem[] = tasks.filter((t) => !t.parent).map((t) => {
    const children = tasks.filter((c) => c.parent === t.id);
    const allFiles = [...new Set([...t.files, ...children.flatMap((c) => c.files)])];
    const allTests = [...new Set([...t.tests, ...children.flatMap((c) => c.tests)])];
    const done = t.heading ? children.length > 0 && children.every((c) => c.done) : t.done;
    return { ...t, done, children, allFiles, allTests };
  });
  const topIds = new Set(topLevel.map((t) => t.id));

  for (const t of tasks) {
    for (const d of t.deps) {
      if (!topIds.has(d)) issues.push({ line: t.line, severity: "error", message: `Task ${t.id} depends on task ${d}, which does not exist (deps name top-level tasks).` });
      else if (d === t.id || d === t.parent) issues.push({ line: t.line, severity: "error", message: `Task ${t.id} depends on itself.` });
    }
  }
  if (tasks.length === 0) {
    issues.push({ line: 1, severity: "error", message: 'No tasks found: write "- [ ] 1. Title" checkboxes.' });
  }

  if (requirements) {
    const known = new Set(requirements.criteria.map((c) => c.id));
    const cited = new Set<string>();
    for (const t of tasks) {
      for (const r of t.requirements) {
        cited.add(r);
        // A bare requirement number ("2") cites all of its criteria.
        if (/^\d+$/.test(r)) {
          const all = requirements.criteria.filter((c) => c.id.startsWith(`${r}.`));
          if (all.length === 0) issues.push({ line: t.line, severity: "error", message: `Task ${t.id} cites requirement ${r}, which does not exist.` });
          all.forEach((c) => cited.add(c.id));
        } else if (!known.has(r)) {
          issues.push({ line: t.line, severity: "error", message: `Task ${t.id} cites criterion ${r}, which is not in the requirements.` });
        }
      }
    }
    for (const c of requirements.criteria) {
      if (!cited.has(c.id)) issues.push({ line: 1, severity: "warning", message: `No task covers criterion ${c.id}.` });
    }
  }
  return { tasks, topLevel, issues };
}

/** Ticks or clears the box on a 1-based line of tasks.md, leaving every other byte alone. */
export function setTaskChecked(text: string, line: number, checked: boolean): string {
  let start = 0;
  for (let n = 1; n < line; n++) {
    const nl = text.indexOf("\n", start);
    if (nl < 0) return text;
    start = nl + 1;
  }
  const end = text.indexOf("\n", start);
  const row = end < 0 ? text.slice(start) : text.slice(start, end);
  const next = row.replace(/^(\s*[-*]\s+\[)( |x|X)(\])/, `$1${checked ? "x" : " "}$3`);
  return text.slice(0, start) + next + (end < 0 ? "" : text.slice(end));
}

// ─── design ───────────────────────────────────────────────────────────────────

export function parseDesign(text: string): DesignDoc {
  const issues: SpecIssue[] = [];
  const ls = lines(text);
  const open = ls.findIndex((l) => /^\s*```+\s*ppm-test\s*$/.test(l));
  if (open < 0) return { testCommand: null, issues };
  const close = ls.findIndex((l, i) => i > open && /^\s*```+\s*$/.test(l));
  if (close < 0) {
    issues.push({ line: open + 1, severity: "error", message: "The ppm-test block is not closed with ```." });
    return { testCommand: null, issues };
  }
  const fields: Record<string, string> = {};
  for (const l of ls.slice(open + 1, close)) {
    const m = l.match(/^\s*(task|suite)\s*:\s*(.+?)\s*$/i);
    if (m) fields[m[1]!.toLowerCase()] = m[2]!;
  }
  if (!fields.task || !fields.suite) {
    issues.push({ line: open + 1, severity: "error", message: "The ppm-test block needs both lines: `task: <command with {files}>` and `suite: <command>`." });
    return { testCommand: null, issues };
  }
  if (!fields.task.includes("{files}")) {
    issues.push({ line: open + 1, severity: "warning", message: "The task command has no {files}: every task will run the same tests." });
  }
  return { testCommand: { task: fields.task, suite: fields.suite }, issues };
}

export const hasErrors = (issues: SpecIssue[]): boolean => issues.some((i) => i.severity === "error");

export function firstError(issues: SpecIssue[]): string | null {
  const e = issues.find((i) => i.severity === "error");
  return e ? `line ${e.line}: ${e.message}` : null;
}
