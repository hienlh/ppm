import { describe, it, expect } from "bun:test";
import { previewTeamMessage } from "../../../src/web/components/chat/team-message-preview.ts";

describe("previewTeamMessage", () => {
  it("renders a task_assignment as subject + description, never raw JSON", () => {
    const raw = JSON.stringify({
      type: "task_assignment",
      taskId: "9",
      subject: "P9: E2E screenshots, docs, final review",
      description: "After P8 merge: run CDP headless-Chrome e2e per phase-09.",
      assignedBy: "team-lead",
      timestamp: "2026-09-03T00:19:07.516Z",
    });
    const out = previewTeamMessage(raw);
    expect(out.title).toBe("P9: E2E screenshots, docs, final review");
    expect(out.detail).toBe("After P8 merge: run CDP headless-Chrome e2e per phase-09.");
    expect(out.taskId).toBe("9");
    // The whole point: no JSON punctuation leaks into what is rendered
    expect(out.title).not.toContain('{"');
    expect(out.detail).not.toContain('{"');
  });

  it("prefers an author-supplied summary over payload fields", () => {
    const raw = JSON.stringify({ type: "task_assignment", subject: "from payload" });
    expect(previewTeamMessage(raw, "from author").title).toBe("from author");
  });

  it("never repeats the headline as the detail", () => {
    const raw = JSON.stringify({ type: "completion", description: "only field present" });
    const out = previewTeamMessage(raw);
    expect(out.title).toBe("only field present");
    expect(out.detail).toBeUndefined();
  });

  it("reads reason from a shutdown payload", () => {
    const raw = JSON.stringify({ type: "shutdown_request", reason: "work finished" });
    expect(previewTeamMessage(raw).title).toBe("work finished");
  });

  it("reads feedback from a plan approval response", () => {
    const raw = JSON.stringify({ type: "plan_approval_response", approve: true, feedback: "looks good, proceed" });
    expect(previewTeamMessage(raw).title).toBe("looks good, proceed");
  });

  it("splits plain prose into first line + rest", () => {
    const out = previewTeamMessage("Done with phase 3\nAll tests pass\nSee report");
    expect(out.title).toBe("Done with phase 3");
    expect(out.detail).toBe("All tests pass\nSee report");
  });

  it("keeps single-line prose as the headline with no detail", () => {
    const out = previewTeamMessage("ack");
    expect(out.title).toBe("ack");
    expect(out.detail).toBeUndefined();
  });

  it("describes an unrecognised payload as key: value instead of JSON", () => {
    const raw = JSON.stringify({ type: "future_kind", phase: "7", branch: "feat/x" });
    const out = previewTeamMessage(raw);
    expect(out.title).toBe("phase: 7 · branch: feat/x");
    expect(out.title).not.toContain("{");
  });

  it("falls back to the payload type when only envelope keys are present", () => {
    expect(previewTeamMessage(JSON.stringify({ type: "idle_notification" })).title).toBe("idle_notification");
  });

  it("handles empty and whitespace-only text", () => {
    expect(previewTeamMessage("").title).toBe("");
    expect(previewTeamMessage("   ").title).toBe("");
    expect(previewTeamMessage("", "labelled").title).toBe("labelled");
  });

  it("handles a JSON scalar or array payload without crashing", () => {
    expect(previewTeamMessage("42").title).toBe("42");
    expect(previewTeamMessage('["a","b"]').title).toBe('["a","b"]');
  });

  it("accepts snake_case task_id", () => {
    const raw = JSON.stringify({ type: "task_assignment", task_id: "4", subject: "Wave 1 integration" });
    const out = previewTeamMessage(raw);
    expect(out.taskId).toBe("4");
    expect(out.title).toBe("Wave 1 integration");
  });
});
