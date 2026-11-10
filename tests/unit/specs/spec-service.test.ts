/**
 * The spec service end to end against a real project folder and a real `bun test`: the Thorough
 * flow (red, green, the whole suite against its baseline) and the ways an AI could cheat it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "ppm-spec-home-"));
process.env.PPM_HOME = home;

const svc = await import("../../../src/services/specs/spec.service.ts");
const { onSpecEvent } = await import("../../../src/services/specs/spec-events.ts");
const { resetSpecSessionsCache, specForSession } = await import("../../../src/services/specs/spec-store.ts");

let project: string;

const REQ = `# Requirements: Sum

UI: no

### Requirement 1: Add numbers

#### Acceptance Criteria

1. WHEN two numbers are given THE SYSTEM SHALL return their sum
`;
const DESIGN = "# Design: Sum\n\n```ppm-test\ntask: bun test {files}\nsuite: bun test\n```\n";
const TASKS = `# Implementation Plan: Sum

- [ ] 1. Sum function
  - _Requirements: 1.1_
  - _Files: sum.ts, sum.test.ts_
  - _Test: sum.test.ts_
`;

const write = (rel: string, text: string) => writeFileSync(join(project, rel), text);
const specFile = (slug: string, name: string) => join(project, "specs", slug, name);

async function approvedThorough(slug = "sum") {
  await svc.createSpec(project, { title: "Sum", slug, checks: "thorough", sessionId: `chat-${slug}` });
  writeFileSync(specFile(slug, "requirements.md"), REQ);
  expect((await svc.approvePhase(project, slug, "requirements")).ok).toBe(true);
  writeFileSync(specFile(slug, "design.md"), DESIGN);
  expect((await svc.approvePhase(project, slug, "design")).ok).toBe(true);
  writeFileSync(specFile(slug, "tasks.md"), TASKS);
  const r = await svc.approvePhase(project, slug, "tasks");
  expect(r.ok).toBe(true);
  await svc.baselineSettled(project, slug);
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "ppm-spec-proj-"));
  resetSpecSessionsCache();
});

afterAll(() => rmSync(home, { recursive: true, force: true }));
beforeAll(() => {});

describe("creating and approving", () => {
  it("creates the folder from templates and binds the chat", async () => {
    const events: string[] = [];
    const off = onSpecEvent((e) => events.push(e.slug));
    const v = await svc.createSpec(project, { title: "Export chat", sessionId: "s1" });
    off();
    expect(v.slug).toBe("export-chat");
    expect(v.current).toBe("requirements");
    expect(readFileSync(specFile("export-chat", "requirements.md"), "utf8")).toContain("WHEN");
    expect(specForSession("s1")).toEqual({ projectPath: project, slug: "export-chat" });
    expect(events).toContain("export-chat");
    const again = await svc.createSpec(project, { title: "Export chat" });
    expect(again.slug).toBe("export-chat-2");
    expect((await svc.listSpecs(project)).map((s) => s.slug).sort()).toEqual(["export-chat", "export-chat-2"]);
  });

  it("refuses to approve a phase whose prerequisites are not approved", async () => {
    await svc.createSpec(project, { title: "Sum", slug: "sum" });
    writeFileSync(specFile("sum", "requirements.md"), REQ);
    writeFileSync(specFile("sum", "design.md"), DESIGN);
    const r = await svc.approvePhase(project, "sum", "design");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/requirements/);
  });

  it("writes the next document's template once a phase is approved", async () => {
    await svc.createSpec(project, { title: "Sum", slug: "sum" });
    writeFileSync(specFile("sum", "requirements.md"), REQ);
    await svc.approvePhase(project, "sum", "requirements");
    expect(readFileSync(specFile("sum", "design.md"), "utf8")).toContain("ppm-test");
  });

  it("a quick spec approves on submit", async () => {
    await svc.createSpec(project, { title: "Quick", slug: "q", kind: "quick" });
    writeFileSync(specFile("q", "requirements.md"), REQ);
    const r = await svc.submitPhase(project, "q", "requirements");
    expect(r.ok).toBe(true);
    expect(r.autoApproved).toBe(true);
    expect(r.view.phases.requirements.status).toBe("approved");
  });
});

describe("Standard", () => {
  it("finishes a task with task_done and ticks its box", async () => {
    await svc.createSpec(project, { title: "Sum", slug: "sum" });
    writeFileSync(specFile("sum", "requirements.md"), REQ);
    await svc.approvePhase(project, "sum", "requirements");
    writeFileSync(specFile("sum", "design.md"), DESIGN);
    await svc.approvePhase(project, "sum", "design");
    writeFileSync(specFile("sum", "tasks.md"), TASKS);
    await svc.approvePhase(project, "sum", "tasks");
    expect((await svc.startTask(project, "sum", "1")).ok).toBe(true);
    expect((await svc.taskRed(project, "sum", "1")).ok).toBe(false);
    const done = await svc.taskDone(project, "sum", "1", "added sum");
    expect(done.ok).toBe(true);
    expect(readFileSync(specFile("sum", "tasks.md"), "utf8")).toContain("- [x] 1. Sum function");
    // Ticking the box must not reopen the approved list.
    expect(done.view.phases.tasks.status).toBe("approved");
    expect(done.view.tasks[0].done).toBe(true);
  });
});

describe("Thorough, with a real bun test", () => {
  it("red then green, then the whole suite", async () => {
    await approvedThorough();
    expect((await svc.startTask(project, "sum", "1")).ok).toBe(true);
    expect((await svc.taskDone(project, "sum", "1", "x")).ok).toBe(false);

    // No test written yet.
    const none = await svc.taskRed(project, "sum", "1");
    expect(none.ok).toBe(false);
    expect(none.message).toMatch(/sum\.test\.ts/);

    // A test that cannot load is not a red.
    write("sum.test.ts", `import { sum } from "./sum.ts";\nimport { it, expect } from "bun:test";\nit("adds", () => expect(sum(1, 2)).toBe(3));\n`);
    const broken = await svc.taskRed(project, "sum", "1");
    expect(broken.ok).toBe(false);
    expect(broken.message).toMatch(/Not a valid red/);

    // A stub that loads and fails on the assertion is.
    write("sum.ts", "export const sum = (a: number, b: number) => 0;\n");
    const red = await svc.taskRed(project, "sum", "1");
    expect(red.message).toContain("Red");
    expect(red.ok).toBe(true);
    expect(red.view.tasks[0].status).toBe("red");

    // Not green while the code is still wrong.
    const notYet = await svc.taskGreen(project, "sum", "1");
    expect(notYet.ok).toBe(false);
    expect(notYet.message).toMatch(/Not green/);

    write("sum.ts", "export const sum = (a: number, b: number) => a + b;\n");
    const green = await svc.taskGreen(project, "sum", "1");
    expect(green.message).toContain("Green");
    expect(green.ok).toBe(true);
    expect(green.message).toMatch(/no new failures/);
    expect(green.view.tasks[0].done).toBe(true);
    expect(readFileSync(specFile("sum", "tasks.md"), "utf8")).toContain("- [x] 1.");
  }, 60_000);

  it("refuses green when the test changed after red", async () => {
    await approvedThorough();
    await svc.startTask(project, "sum", "1");
    write("sum.ts", "export const sum = (a: number, b: number) => 0;\n");
    write("sum.test.ts", `import { sum } from "./sum.ts";\nimport { it, expect } from "bun:test";\nit("adds", () => expect(sum(1, 2)).toBe(3));\n`);
    expect((await svc.taskRed(project, "sum", "1")).ok).toBe(true);
    write("sum.test.ts", `import { it, expect } from "bun:test";\nit("adds", () => expect(1).toBe(1));\n`);
    const r = await svc.taskGreen(project, "sum", "1");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/changed after the red/);
  }, 60_000);

  it("refuses a red whose tests already pass", async () => {
    await approvedThorough();
    await svc.startTask(project, "sum", "1");
    write("sum.ts", "export const sum = (a: number, b: number) => a + b;\n");
    write("sum.test.ts", `import { sum } from "./sum.ts";\nimport { it, expect } from "bun:test";\nit("adds", () => expect(sum(1, 2)).toBe(3));\n`);
    const r = await svc.taskRed(project, "sum", "1");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/already pass/);
  }, 60_000);

  it("a new failure elsewhere in the suite blocks further tasks; an old one does not", async () => {
    // An old failure the baseline records.
    mkdirSync(join(project, "old"));
    write("old/old.test.ts", `import { it, expect } from "bun:test";\nit("old failure", () => expect(1).toBe(2));\n`);
    await approvedThorough();
    const base = (await svc.getSpec(project, "sum")).baseline;
    expect(base?.outcome).toBe("fail");

    await svc.startTask(project, "sum", "1");
    write("sum.ts", "export const sum = (a: number, b: number) => 0;\n");
    write("sum.test.ts", `import { sum } from "./sum.ts";\nimport { it, expect } from "bun:test";\nit("adds", () => expect(sum(1, 2)).toBe(3));\n`);
    expect((await svc.taskRed(project, "sum", "1")).ok).toBe(true);
    write("sum.ts", "export const sum = (a: number, b: number) => a + b;\n");
    // The change breaks something else.
    write("other.test.ts", `import { it, expect } from "bun:test";\nit("other", () => expect(2).toBe(3));\n`);
    const green = await svc.taskGreen(project, "sum", "1");
    expect(green.ok).toBe(true);
    expect(green.message).toMatch(/1 new failure/);
    expect(green.view.suite?.newFailures.join()).toContain("other");
    expect(green.view.suite?.newFailures.join()).not.toContain("old failure");

    write("other.test.ts", `import { it, expect } from "bun:test";\nit("other", () => expect(3).toBe(3));\n`);
    const again = await svc.checkSuite(project, "sum");
    expect(again.ok).toBe(true);
  }, 90_000);

  it("only PPM's green finishes a task: a box the AI ticked does not count", async () => {
    await approvedThorough();
    writeFileSync(specFile("sum", "tasks.md"), TASKS.replace("- [ ] 1.", "- [x] 1."));
    const v = await svc.getSpec(project, "sum");
    expect(v.tasks[0].done).toBe(false);
  });
});

describe("serializes work on one spec", () => {
  it("runs locked calls in order", async () => {
    const order: number[] = [];
    await Promise.all([
      svc.withSpecLock("/p", "s", async () => { await Bun.sleep(20); order.push(1); }),
      svc.withSpecLock("/p", "s", async () => { order.push(2); }),
    ]);
    expect(order).toEqual([1, 2]);
  });
});
