/**
 * What the spec's chat is told after an approval, built from real spec views. The case that sent
 * nothing: the AI changes requirements.md after every document was approved, the user approves it
 * again, and the spec goes straight back to execution.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "ppm-spec-msg-home-"));
process.env.PPM_HOME = home;

const svc = await import("../../../src/services/specs/spec.service.ts");
const { approvalMessage } = await import("../../../src/services/specs/spec-approval-message.ts");
const { resetSpecSessionsCache } = await import("../../../src/services/specs/spec-store.ts");

const REQ = "# Requirements: Sum\n\nUI: no\n\n### Requirement 1: Add numbers\n\n#### Acceptance Criteria\n\n1. WHEN two numbers are given THE SYSTEM SHALL return their sum\n";
const DESIGN = "# Design: Sum\n\nA function.\n";
const TASKS = "# Implementation Plan: Sum\n\n- [ ] 1. Sum function\n  - _Requirements: 1.1_\n  - _Files: sum.ts_\n";

let project: string;
const file = (name: string) => join(project, "specs", "sum", name);

async function approve(phase: "requirements" | "design" | "tasks") {
  const r = await svc.approvePhase(project, "sum", phase);
  expect(r.ok).toBe(true);
  return approvalMessage(r.view, phase);
}

beforeEach(async () => {
  project = mkdtempSync(join(tmpdir(), "ppm-spec-msg-proj-"));
  resetSpecSessionsCache();
  await svc.createSpec(project, { title: "Sum", slug: "sum", sessionId: "chat-sum" });
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("approval message", () => {
  it("tells the AI to go on with the next document on the first pass", async () => {
    writeFileSync(file("requirements.md"), REQ);
    expect(await approve("requirements")).toBe("I approved requirements.md. Go on with specs/sum/design.md (its template is there), and submit it when it is ready.");
  });

  it("says something when an approval given again lands straight in execution", async () => {
    writeFileSync(file("requirements.md"), REQ);
    await approve("requirements");
    writeFileSync(file("design.md"), DESIGN);
    await approve("design");
    writeFileSync(file("tasks.md"), TASKS);
    expect(await approve("tasks")).toBe("I approved tasks.md. Every document is approved: wait for me to start the tasks (Start task or Run all), do not start them yourself.");

    writeFileSync(file("requirements.md"), REQ.replace("their sum", "their sum as an integer"));
    const msg = await approve("requirements");
    expect(msg).toContain("I approved requirements.md.");
    expect(msg).toContain("specs/sum/design.md and specs/sum/tasks.md are still approved as written. If this change affects them, update them and submit again.");
    expect(msg).toContain("Otherwise every document is approved");
  });

  it("names a later document the AI already changed", async () => {
    writeFileSync(file("requirements.md"), REQ);
    await approve("requirements");
    writeFileSync(file("design.md"), DESIGN);
    await approve("design");
    writeFileSync(file("tasks.md"), TASKS);
    await approve("tasks");

    writeFileSync(file("requirements.md"), REQ.replace("their sum", "their sum as an integer"));
    writeFileSync(file("design.md"), DESIGN.replace("A function.", "An integer function."));
    const msg = await approve("requirements");
    expect(msg).toContain("specs/sum/tasks.md is still approved as written.");
    expect(msg).toContain("specs/sum/design.md changed since I approved it: check it, then submit it again.");
  });
});
