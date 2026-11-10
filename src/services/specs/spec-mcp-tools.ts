import {
  SPEC_OPEN_DESIGN_TOOL, SPEC_CREATE_TOOL, SPEC_STATUS_TOOL, SPEC_SUBMIT_TOOL, SUITE_CHECK_TOOL,
  TASK_DONE_TOOL, TASK_GREEN_TOOL, TASK_RED_TOOL, TASK_START_TOOL,
} from "../../shared/spec-tools.ts";

/**
 * What `/api/specs-mcp` serves. The AI writes the spec's documents with its ordinary file tools;
 * these tools are the steps PPM keeps the record of — asking for an approval, starting and
 * finishing a task, and in Thorough the test runs that only PPM may judge. None of them approves
 * anything: approvals are the user's, in PPM.
 */

const TASK = { type: "string", description: 'The top-level task number from tasks.md, e.g. "2".' };
const none = { type: "object", properties: {}, additionalProperties: false };

export const SPEC_TOOL_DEFINITIONS = [
  {
    name: SPEC_STATUS_TOOL,
    title: "Spec status",
    description: "This chat's spec: the phase it is at, each document's state and problems, the tasks with their wave, status and next step, and the last test runs. Call it when unsure what to do next.",
    inputSchema: none,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: SPEC_CREATE_TOOL,
    title: "Start a spec",
    description: "Start a spec (Spec mode) for this chat when the user asks for one: PPM creates specs/<slug>/ with the first document's template and binds this chat to it. kind: feature (requirements → design → tasks), bugfix (bug analysis → design → tasks) or quick (all three documents, no approval stops). checks: standard (you mark tasks done) or thorough (PPM runs the tests: red, then green). Ask the user which checks they want when they have not said.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short name of the feature or bug." },
        kind: { type: "string", enum: ["feature", "bugfix", "quick"] },
        workflow: { type: "string", enum: ["requirements-first", "design-first"], description: "Feature specs only; default requirements-first." },
        checks: { type: "string", enum: ["standard", "thorough"] },
      },
      required: ["title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  {
    name: SPEC_SUBMIT_TOOL,
    title: "Submit for approval",
    description: "Say a document is ready: PPM checks it parses and follows the rules, then shows it to the user to approve. On success stop and wait for the user — never continue to the next phase on your own. On failure fix what it names and submit again.",
    inputSchema: {
      type: "object",
      properties: { phase: { type: "string", enum: ["requirements", "design", "tasks"] } },
      required: ["phase"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  {
    name: SPEC_OPEN_DESIGN_TOOL,
    title: "Draw the screens",
    description: "For a spec whose requirements say UI: yes: PPM creates the spec's PPM Design (designs/<slug>/) and opens it for the user. Draw the screens there as one self-contained HTML page (index.html), then tell the user; they approve the drawing in PPM before design.md. Tasks that build a screen name it with _Screen: <name>_.",
    inputSchema: none,
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  {
    name: TASK_START_TOOL,
    title: "Start a task",
    description: "Start one task of the approved tasks.md before working on it. Refused while its _Deps:_ are not done or a running task shares one of its _Files:_.",
    inputSchema: { type: "object", properties: { task: TASK }, required: ["task"], additionalProperties: false },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  {
    name: TASK_DONE_TOOL,
    title: "Finish a task",
    description: "Finish a started task (Standard checks, or a Thorough task marked _Test: none_). PPM ticks its box in tasks.md — do not tick boxes yourself.",
    inputSchema: {
      type: "object",
      properties: { task: TASK, summary: { type: "string", description: "One or two sentences on what changed." } },
      required: ["task", "summary"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  {
    name: TASK_RED_TOOL,
    title: "Tests fail first",
    description: "Thorough: after writing the task's tests (its _Test:_ files) and before the code, PPM runs them and must see them fail on an assertion — a load, import or compile error is not a red. On success the test files are locked: from now on change the code, never the tests.",
    inputSchema: { type: "object", properties: { task: TASK }, required: ["task"], additionalProperties: false },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  {
    name: TASK_GREEN_TOOL,
    title: "Tests pass",
    description: "Thorough: after writing the code, PPM runs the task's tests (unchanged since the red) and finishes the task when they pass; then the whole suite is compared with the failures it already had. Fix whatever it reports and call it again.",
    inputSchema: { type: "object", properties: { task: TASK }, required: ["task"], additionalProperties: false },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  {
    name: SUITE_CHECK_TOOL,
    title: "Check the whole suite",
    description: "Thorough: run the whole test suite again after fixing failures it reported. New failures since the baseline hold every further task.",
    inputSchema: none,
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
] as const;
