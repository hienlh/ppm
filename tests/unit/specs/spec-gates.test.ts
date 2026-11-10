import { describe, expect, it } from "bun:test";
import { evaluateSpec, type GateDocs } from "../../../src/services/specs/spec-gates.ts";
import { emptySpecState, type SpecState } from "../../../src/shared/spec-types.ts";

const REQ = `### Requirement 1: A
#### Acceptance Criteria
1. WHEN x THE SYSTEM SHALL y
UI: no
`;
const DESIGN = "# Design\n\n```ppm-test\ntask: bun test {files}\nsuite: bun test\n```\n";
const TASKS = `- [ ] 1. First
  - _Requirements: 1.1_
  - _Files: a.ts_
  - _Test: a.test.ts_
- [ ] 2. Second
  - _Requirements: 1.1_
  - _Deps: 1_
  - _Files: b.ts_
  - _Test: b.test.ts_
- [ ] 3. Third
  - _Requirements: 1.1_
  - _Files: c.ts_
  - _Test: none — config only_
`;

function docs(over: Partial<Record<keyof GateDocs, string | null>> = {}): GateDocs {
  return {
    requirements: over.requirements === undefined ? REQ : over.requirements,
    design: over.design === undefined ? DESIGN : over.design,
    tasks: over.tasks === undefined ? TASKS : over.tasks,
  };
}

function state(over: Partial<SpecState> = {}): SpecState {
  return { ...emptySpecState({ slug: "s", title: "S", kind: "feature", workflow: "requirements-first", checks: "standard" }), ...over };
}

/** Approves every phase whose document is given, with the hash evaluateSpec computes. */
function approveAll(d: GateDocs, s: SpecState, phases = ["requirements", "design", "tasks"] as const): SpecState {
  const v = evaluateSpec(d, s);
  const approvals = { ...s.approvals };
  for (const p of phases) approvals[p] = { hash: v.phases[p].hash!, at: "t" };
  return { ...s, approvals };
}

describe("phases", () => {
  it("starts on requirements, as a draft", () => {
    const v = evaluateSpec(docs({ design: null, tasks: null }), state());
    expect(v.current).toBe("requirements");
    expect(v.phases.requirements.status).toBe("draft");
    expect(v.phases.design.status).toBe("missing");
    expect(v.canSubmit("requirements").ok).toBe(true);
    expect(v.canSubmit("design").ok).toBe(false);
  });

  it("moves on once a phase is approved, and reopens it when the file changes", () => {
    const d = docs({ design: null, tasks: null });
    const s = approveAll(d, state(), ["requirements"]);
    expect(evaluateSpec(d, s).current).toBe("design");
    const edited = { ...d, requirements: REQ + "\n2. WHEN a THE SYSTEM SHALL b\n" };
    const v = evaluateSpec(edited, s);
    expect(v.phases.requirements.status).toBe("stale");
    expect(v.current).toBe("requirements");
  });

  it("refuses to submit a document that does not parse", () => {
    const v = evaluateSpec(docs({ requirements: "nothing", design: null, tasks: null }), state());
    expect(v.phases.requirements.status).toBe("invalid");
    const r = v.canSubmit("requirements");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/line/i);
  });

  it("design first puts design before requirements", () => {
    const s = state({ workflow: "design-first" });
    const v = evaluateSpec(docs({ requirements: null, tasks: null }), s);
    expect(v.order).toEqual(["design", "requirements", "tasks"]);
    expect(v.current).toBe("design");
  });

  it("a stale earlier phase blocks the later ones even if they are approved", () => {
    const d = docs();
    const s = approveAll(d, state());
    expect(evaluateSpec(d, s).current).toBe("execution");
    const v = evaluateSpec({ ...d, requirements: REQ.replace("y", "z") }, s);
    expect(v.current).toBe("requirements");
    expect(v.canStartTask("1").ok).toBe(false);
  });

  it("Thorough needs a test command in design.md before design can be approved", () => {
    const v = evaluateSpec(docs({ design: "# Design\n", tasks: null }), approveAll(docs(), state({ checks: "thorough" }), ["requirements"]));
    expect(v.canApprove("design").ok).toBe(false);
    expect(v.canApprove("design").reason).toMatch(/test command/i);
    const std = evaluateSpec(docs({ design: "# Design\n", tasks: null }), approveAll(docs(), state(), ["requirements"]));
    expect(std.canApprove("design").ok).toBe(true);
  });

  it("UI: yes needs the drawing approved before design", () => {
    const d = docs({ requirements: REQ.replace("UI: no", "UI: yes"), tasks: null });
    const s = approveAll(d, state(), ["requirements"]);
    expect(evaluateSpec(d, s).canApprove("design").reason).toMatch(/drawing/i);
    const drawn = { ...s, approvals: { ...s.approvals, drawing: { hash: "d1", at: "t" } } };
    expect(evaluateSpec(d, drawn, { drawingHash: "d1" }).canApprove("design").ok).toBe(true);
    expect(evaluateSpec(d, drawn, { drawingHash: "d2" }).canApprove("design").reason).toMatch(/drawing/i);
  });

  it("Thorough refuses tasks with neither a test nor a reason for none", () => {
    const d = docs({ tasks: TASKS.replace("  - _Test: b.test.ts_\n", "") });
    const s = approveAll(d, state({ checks: "thorough" }), ["requirements", "design"]);
    const r = evaluateSpec(d, s).canSubmit("tasks");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("2");
  });
});

describe("tasks", () => {
  const ready = () => approveAll(docs(), state());

  it("starts tasks whose deps are done", () => {
    const v = evaluateSpec(docs(), ready());
    expect(v.canStartTask("1").ok).toBe(true);
    expect(v.canStartTask("3").ok).toBe(true);
    expect(v.canStartTask("2").reason).toMatch(/1/);
  });

  it("refuses a task whose files a running task holds", () => {
    const d = docs({ tasks: TASKS.replace("_Files: c.ts_", "_Files: a.ts_") });
    const s = approveAll(d, state());
    s.tasks["1"] = { status: "running" };
    const r = evaluateSpec(d, s).canStartTask("3");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("a.ts");
  });

  it("counts a ticked box or a finished state as done", () => {
    const d = docs({ tasks: TASKS.replace("- [ ] 1. First", "- [x] 1. First") });
    expect(evaluateSpec(d, approveAll(d, state())).canStartTask("2").ok).toBe(true);
    const s = ready();
    s.tasks["1"] = { status: "done" };
    expect(evaluateSpec(docs(), s).canStartTask("2").ok).toBe(true);
  });

  it("Standard finishes with done; Thorough with red then green, unless the task has no test", () => {
    const std = ready();
    std.tasks["1"] = { status: "running" };
    expect(evaluateSpec(docs(), std).nextStep("1")).toBe("done");
    const th = approveAll(docs(), state({ checks: "thorough" }));
    th.tasks["1"] = { status: "running" };
    th.tasks["3"] = { status: "running" };
    const v = evaluateSpec(docs(), th);
    expect(v.nextStep("1")).toBe("red");
    expect(v.nextStep("3")).toBe("done");
    th.tasks["1"] = { status: "red" };
    expect(evaluateSpec(docs(), th).nextStep("1")).toBe("green");
  });

  it("exposes the wave plan", () => {
    expect(evaluateSpec(docs(), ready()).waves.waves).toEqual([["1", "3"], ["2"]]);
  });

  it("ticking a box does not reopen the approved task list", () => {
    const s = ready();
    const ticked = docs({ tasks: TASKS.replace("- [ ] 1. First", "- [x] 1. First") });
    expect(evaluateSpec(ticked, s).phases.tasks.status).toBe("approved");
  });

  it("in Thorough a box the AI ticked itself is not done", () => {
    const th = approveAll(docs(), state({ checks: "thorough" }));
    const ticked = docs({ tasks: TASKS.replace("- [ ] 1. First", "- [x] 1. First") });
    expect(evaluateSpec(ticked, th).isTaskDone("1")).toBe(false);
    expect(evaluateSpec(ticked, th).canStartTask("2").ok).toBe(false);
    th.approvals.tasks!.preDone = ["1"];
    expect(evaluateSpec(ticked, th).isTaskDone("1")).toBe(true);
  });

  it("new suite failures hold every further task", () => {
    const s = ready();
    s.suite = { at: "t", command: "c", outcome: "fail", failing: ["x"], passed: 0, failed: 1, weak: false, output: "", durationMs: 1, newFailures: ["x"] };
    expect(evaluateSpec(docs(), s).canStartTask("1").reason).toMatch(/suite/);
  });
});
