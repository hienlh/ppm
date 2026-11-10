import { describe, expect, it } from "bun:test";
import { parseDesign, parseRequirements, parseTasks, setTaskChecked } from "../../../src/shared/spec-format.ts";

const REQUIREMENTS = `# Requirements Document

## Introduction

Export one chat session to a file.

**UI:** yes

## Requirements

### Requirement 1: Export from History

**User Story:** As a user, I want to export a chat, so that I can share it.

#### Acceptance Criteria

1. WHEN the user opens a session's menu THE SYSTEM SHALL show "Export…"
2. WHEN the user picks Markdown THEN the system SHALL download a .md file

### Requirement 2: HTML export

#### Acceptance Criteria

1. WHEN the user picks HTML THE SYSTEM SHALL write one self-contained file
2. IF an image cannot be read THEN THE SYSTEM SHALL keep a placeholder
`;

describe("parseRequirements", () => {
  it("numbers acceptance criteria per requirement, in both of Kiro's spellings", () => {
    const doc = parseRequirements(REQUIREMENTS, "feature");
    expect(doc.requirements.map((r) => r.title)).toEqual(["Export from History", "HTML export"]);
    expect(doc.requirements[0].story).toContain("As a user");
    expect(doc.criteria.map((c) => c.id)).toEqual(["1.1", "1.2", "2.1", "2.2"]);
    expect(doc.criteria[1].text).toContain("THEN the system SHALL");
    expect(doc.ui).toBe(true);
    expect(doc.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("reads UI: no, and leaves it unknown when absent", () => {
    expect(parseRequirements(REQUIREMENTS.replace("**UI:** yes", "UI: no"), "feature").ui).toBe(false);
    expect(parseRequirements(REQUIREMENTS.replace("**UI:** yes", ""), "feature").ui).toBeNull();
  });

  it("reports a document with no criteria as an error with a line", () => {
    const doc = parseRequirements("# Requirements\n\n### Requirement 1: X\n\nnothing here\n", "feature");
    const errors = doc.issues.filter((i) => i.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].line).toBeGreaterThan(0);
  });

  it("parses a bugfix document into current / expected / unchanged", () => {
    const doc = parseRequirements(`# Bugfix

## Current Behavior (Defect)
1. WHEN a name has an apostrophe THEN the system returns a 500

## Expected Behavior (Correct)
1. WHEN a name has an apostrophe THEN the system SHALL save it

## Unchanged Behavior (Regression Prevention)
1. WHEN the email is invalid THEN the system SHALL CONTINUE TO reject it
2. WHEN the password is short THEN the system SHALL CONTINUE TO reject it
`, "bugfix");
    expect(doc.criteria.map((c) => `${c.id}:${c.section}`)).toEqual([
      "1.1:current", "2.1:expected", "3.1:unchanged", "3.2:unchanged",
    ]);
  });
});

const TASKS = `# Implementation Plan

- [x] 1. Markdown writer and export types
  - Write the types
  - _Requirements: 1.2_
  - _Files: src/export/types.ts, src/export/markdown.ts_
  - _Test: tests/unit/export/markdown.test.ts_
- [ ] 2. HTML export
  - _Requirements: 2.1, 2.2_
  - _Deps: 1_
  - _Files: src/export/html.ts_
  - _Test: tests/unit/export/html.test.ts_
  - [x] 2.1 Image inliner
    - _Files: src/export/inline.ts_
  - [ ] 2.2 Placeholder list
- [ ] 3. Export in the History menu
  - _Validates: Requirements 1.1_
  - _Deps: 1_
  - _Files: src/web/history-menu.tsx_
  - _Screen: history-menu_
  - _Test: none — wiring only, covered by the e2e in task 4_
- [ ]* 4. Copy as Markdown
  - _Requirements: 1.2_
`;

describe("parseTasks", () => {
  it("reads ids, state, nesting and every annotation", () => {
    const doc = parseTasks(TASKS);
    expect(doc.tasks.map((t) => t.id)).toEqual(["1", "2", "2.1", "2.2", "3", "4"]);
    const [t1, t2, t21, , t3, t4] = doc.tasks;
    expect(t1.done).toBe(true);
    expect(t1.files).toEqual(["src/export/types.ts", "src/export/markdown.ts"]);
    expect(t1.tests).toEqual(["tests/unit/export/markdown.test.ts"]);
    expect(t2.deps).toEqual(["1"]);
    expect(t2.requirements).toEqual(["2.1", "2.2"]);
    expect(t21.parent).toBe("2");
    expect(t21.done).toBe(true);
    expect(t3.requirements).toEqual(["1.1"]);
    expect(t3.screen).toBe("history-menu");
    expect(t3.noTest).toContain("wiring only");
    expect(t3.tests).toEqual([]);
    expect(t4.optional).toBe(true);
    expect(doc.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("folds sub-task files and tests into the top-level task that runs them", () => {
    const top = parseTasks(TASKS).topLevel;
    expect(top.map((t) => t.id)).toEqual(["1", "2", "3", "4"]);
    expect(top[1].allFiles).toEqual(["src/export/html.ts", "src/export/inline.ts"]);
  });

  it("flags unknown requirement ids and unknown deps against the requirements", () => {
    const req = parseRequirements(REQUIREMENTS, "feature");
    const doc = parseTasks(TASKS.replace("_Requirements: 2.1, 2.2_", "_Requirements: 2.1, 9.9_").replace("_Deps: 1_\n  - _Files: src/web", "_Deps: 7_\n  - _Files: src/web"), req);
    const errors = doc.issues.filter((i) => i.severity === "error").map((i) => i.message);
    expect(errors.some((m) => m.includes("9.9"))).toBe(true);
    expect(errors.some((m) => m.includes("7"))).toBe(true);
  });

  it("warns about criteria no task covers", () => {
    const req = parseRequirements(REQUIREMENTS, "feature");
    const doc = parseTasks("- [ ] 1. Only one\n  - _Requirements: 1.1_\n  - _Files: a.ts_\n", req);
    const warnings = doc.issues.filter((i) => i.severity === "warning").map((i) => i.message);
    expect(warnings.some((m) => m.includes("1.2"))).toBe(true);
  });

  it("rejects duplicate ids", () => {
    const doc = parseTasks("- [ ] 1. A\n- [ ] 1. B\n");
    expect(doc.issues.some((i) => i.severity === "error" && i.message.includes("1"))).toBe(true);
  });

  it("keeps Kiro's `## Task N:` heading form", () => {
    const doc = parseTasks("## Task 1: Setup\n\n- [x] 1.1 Install\n- [ ] 1.2 Configure\n  - _Files: a.ts_\n");
    expect(doc.topLevel.map((t) => [t.id, t.title, t.done])).toEqual([["1", "Setup", false]]);
    expect(doc.tasks.find((t) => t.id === "1.2")?.parent).toBe("1");
  });
});

describe("setTaskChecked", () => {
  it("changes only the box on the task's line and keeps CRLF", () => {
    const text = "- [ ] 1. A\r\n  - [ ] 1.1 B\r\n- [ ] 2. C\r\n";
    const doc = parseTasks(text);
    const out = setTaskChecked(text, doc.tasks.find((t) => t.id === "1.1")!.line, true);
    expect(out).toBe("- [ ] 1. A\r\n  - [x] 1.1 B\r\n- [ ] 2. C\r\n");
    expect(setTaskChecked(out, doc.tasks[1].line, false)).toBe(text);
  });

  it("keeps the optional marker", () => {
    expect(setTaskChecked("- [ ]* 4. Copy\n", 1, true)).toBe("- [x]* 4. Copy\n");
  });
});

describe("parseDesign", () => {
  it("reads the ppm-test block", () => {
    const doc = parseDesign("# Design\n\n## Testing Strategy\n\n```ppm-test\ntask: bun test {files}\nsuite: bun test tests/unit\n```\n");
    expect(doc.testCommand).toEqual({ task: "bun test {files}", suite: "bun test tests/unit" });
  });

  it("has no command when the block is missing or incomplete", () => {
    expect(parseDesign("# Design\n").testCommand).toBeNull();
    const partial = parseDesign("```ppm-test\nsuite: bun test\n```\n");
    expect(partial.testCommand).toBeNull();
    expect(partial.issues.some((i) => i.severity === "error")).toBe(true);
  });
});
