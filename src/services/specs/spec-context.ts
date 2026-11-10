/**
 * What a spec chat's AI is told: the rules of Spec mode and where its spec stands, as one block
 * that rides in front of each message (inside PPM's shared-context markers, so it never shows
 * in the chat's history). Every provider receives it the same way, which is what lets Claude,
 * Codex, Antigravity and Cursor follow one workflow without per-provider system prompts.
 */
import type { SpecView } from "./spec.service.ts";
import { firstError } from "../../shared/spec-format.ts";
import { phaseFileName } from "../../shared/spec-types.ts";

export const SPEC_STATE_START = "<ppm_spec_state>";
export const SPEC_STATE_END = "</ppm_spec_state>";

export interface SpecContextOpts {
  /** Set for a chat PPM started to run one task. */
  taskId?: string;
  /** How the AI reaches the tools: MCP, or the `ppm spec call` command (Cursor). */
  via: "mcp" | "cli";
}

const call = (via: SpecContextOpts["via"], tool: string, args?: string) =>
  via === "mcp" ? `${tool}${args ? ` ${args}` : ""}` : `\`ppm spec call ${tool}${args ? ` '${args}'` : ""}\``;

function rules(v: SpecView, via: SpecContextOpts["via"]): string[] {
  const req = phaseFileName(v.kind, "requirements");
  const thorough = v.checks === "thorough";
  const lines: string[] = [
    `Spec mode. You work through ${v.order.map((p) => phaseFileName(v.kind, p)).join(" → ")} in ${v.folder}/, then the tasks. Write each document with your normal file tools in the format of the template already in it.`,
    `When a document is ready call ${call(via, "spec_submit", '{"phase":"<phase>"}')} and stop: only the user approves, in PPM. Do not start the next document before the approval arrives. Editing an approved document reopens it for approval.`,
    v.kind === "bugfix"
      ? `${req}: "## Current Behavior (Defect)", "## Expected Behavior (Correct)", "## Unchanged Behavior (Regression Prevention)", each a numbered list (ids 1.k, 2.k, 3.k). Find the root cause before writing the design.`
      : `${req}: "### Requirement N: name", a **User Story:** line, "#### Acceptance Criteria" with numbered EARS lines (WHEN … THE SYSTEM SHALL …); criterion k of requirement N is N.k. Put "UI: yes" when the feature adds or changes a screen.`,
    `tasks.md: "- [ ] N. Title" with sub-bullets _Requirements: N.k_ (every criterion covered), _Deps: N_ (what must finish first), _Files: paths_ (everything it creates or changes)${thorough ? ", _Test: test files_ (or _Test: none — reason_)" : ", _Test: …_ optional"}. You decide what can run in parallel: tasks without a dependency between them and with no file in common run side by side. Mark optional tasks "- [ ]* N.". Never tick a box yourself; PPM does.`,
    checksLine(v, via),
  ];
  if (via === "cli") lines.push(CLI_LINE);
  return lines;
}

const CLI_LINE = "Your tools are commands: run `ppm spec call <tool> '<json arguments>'` in the shell (the token is in $PPM_SPEC_TOKEN), e.g. `ppm spec call spec_status`.";

function checksLine(v: SpecView, via: SpecContextOpts["via"]): string {
  return v.checks === "thorough"
    ? `Checks: Thorough — PPM runs the tests. design.md must hold a \`\`\`ppm-test block (task: <command with {files}>, suite: <command>). For each task: ${call(via, "task_start")} → write its failing tests → ${call(via, "task_red")} (must fail on an assertion) → write the code, never touching the locked tests → ${call(via, "task_green")}.`
    : `Checks: Standard — for each task: ${call(via, "task_start")} → do the work → ${call(via, "task_done")} with a one-line summary.`;
}

function stepNow(v: SpecView, via: SpecContextOpts["via"]): string {
  if (v.current !== "execution") {
    const ph = v.phases[v.current];
    const file = ph.file;
    const issue = firstError(ph.issues);
    const note = [...v.changeRequests].reverse().find((r) => r.phase === v.current);
    switch (ph.status) {
      case "missing": return `Now: write ${file}.`;
      case "invalid": return `Now: fix ${file} — ${issue}`;
      case "stale": return `Now: ${file} changed after it was approved; submit it again with ${call(via, "spec_submit", `{"phase":"${v.current}"}`)} when it is right.`;
      default:
        if (v.current === "design" && v.needsDrawing && v.drawing !== "approved") {
          return v.drawing === "missing"
            ? `Now: the requirements say UI: yes. Call ${call(via, "spec_open_design")} and draw the screens before design.md can be approved.`
            : `Now: the drawing (designs/${v.designSlug}/) waits for the user's approval${v.drawing === "stale" ? " again — it changed after they approved it" : ""}. Write design.md meanwhile.`;
        }
        return note
          ? `Now: the user asked for changes to ${file}: "${note.note}". Make them, then submit again.`
          : `Now: finish ${file} and submit it, or wait for the user's approval if you already did.`;
    }
  }
  if (v.needsDrawing && v.drawing !== "approved" && v.drawing !== "not-needed") return "Now: the UI drawing waits for the user's approval.";
  const open = v.tasks.filter((t) => !t.optional && !t.done);
  if (!open.length) return "All required tasks are done. Tell the user, and offer the optional ones if any.";
  const running = open.filter((t) => t.status === "running" || t.status === "red");
  if (running.length) return `Running: ${running.map((t) => `task ${t.id} (next: ${t.next})`).join(", ")}.`;
  const ready = open.filter((t) => t.next === "start").map((t) => t.id);
  return ready.length
    ? `Tasks are approved. Ready to start: ${ready.join(", ")}. Run the one the user asks for (or all, in order, if they said so).`
    : `No task can start: ${open[0]!.blockedReason ?? "waiting"}.`;
}

/** The block a spec chat's message carries. */
export function buildSpecContext(v: SpecView, opts: SpecContextOpts): string {
  const out = [SPEC_STATE_START];
  out.push(`Spec "${v.title}" (${v.folder}/, ${v.kind}, checks: ${v.checks}).`);
  if (opts.taskId) {
    const t = v.tasks.find((x) => x.id === opts.taskId);
    out.push(checksLine(v, opts.via));
    if (opts.via === "cli") out.push(CLI_LINE);
    out.push(`You run task ${opts.taskId} only${t ? ` — "${t.title}" (files: ${t.files.join(", ") || "none declared"}${t.tests.length ? `; tests: ${t.tests.join(", ")}` : ""})` : ""}. Read requirements, design and tasks.md first. Other tasks run in other chats beside you: touch only this task's files. Status: ${t ? `${t.status}, next: ${t.next}` : "unknown"}.`);
    if (t?.run?.lastRun) out.push(`Last test run: ${t.run.lastRun.outcome} — ${t.run.lastRun.failing.slice(0, 5).join("; ") || t.run.lastRun.command}.`);
  } else {
    out.push(...rules(v, opts.via));
    out.push(stepNow(v, opts.via));
    if (v.suite?.newFailures.length) out.push(`The whole suite has new failures since the baseline: ${v.suite.newFailures.slice(0, 5).join("; ")}. Fix them, then ${call(opts.via, "suite_check")}.`);
  }
  out.push(SPEC_STATE_END);
  return out.join("\n");
}

/** A readable status for `spec_status`. */
export function formatSpecStatus(v: SpecView): string {
  const lines = [`Spec "${v.title}" — ${v.folder}/ — ${v.kind}, ${v.checks}. Phase: ${v.current}.`];
  for (const p of v.order) {
    const ph = v.phases[p];
    const issues = ph.issues.filter((i) => i.severity === "error").slice(0, 3).map((i) => `line ${i.line}: ${i.message}`);
    lines.push(`- ${ph.file}: ${ph.status}${issues.length ? ` — ${issues.join("; ")}` : ""}`);
  }
  if (v.needsDrawing) lines.push(`- UI drawing: ${v.drawing}`);
  if (v.testCommand) lines.push(`Test commands — task: ${v.testCommand.task}; suite: ${v.testCommand.suite}`);
  if (v.tasks.length) {
    lines.push("Tasks (wave = which run side by side):");
    for (const t of v.tasks) {
      const why = t.blockedReason ? ` — ${t.blockedReason}` : "";
      lines.push(`- ${t.id}${t.optional ? "*" : ""}. ${t.title} [${t.done ? "done" : t.status}] wave ${t.wave === null ? "-" : t.wave + 1}, next: ${t.next}${why}`);
    }
    for (const m of v.waves.moved) lines.push(`  (task ${m.id} moved to a later wave: ${m.reason})`);
  }
  if (v.baseline) lines.push(`Baseline: ${v.baseline.outcome}, ${v.baseline.failing.length} failing before the work.`);
  if (v.suite) lines.push(`Last suite: ${v.suite.outcome}; new failures: ${v.suite.newFailures.join("; ") || "none"}.`);
  return lines.join("\n");
}

/** Splits a shared context into what PPM shares across providers and the spec block. */
export function splitSpecContext(context: string): { shared: string; spec: string | null } {
  const at = context.indexOf(SPEC_STATE_START);
  if (at < 0) return { shared: context, spec: null };
  return { shared: context.slice(0, at).trimEnd(), spec: context.slice(at) };
}
