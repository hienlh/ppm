import { describe, it, expect } from "bun:test";
import { aggregateTasks, type TaskItem } from "../../../src/services/task-status-aggregator.ts";
import type { ChatMessage, ChatEvent } from "../../../src/types/chat.ts";

/** Build an assistant ChatMessage from events (mirrors parsed JSONL shape). */
function asst(events: ChatEvent[], id = "m"): ChatMessage {
  return { id, role: "assistant", content: "", events, timestamp: "2026-06-15T00:00:00Z" };
}
const create = (toolUseId: string, subject: string): ChatEvent =>
  ({ type: "tool_use", tool: "TaskCreate", input: { subject, description: "d", activeForm: "a" }, toolUseId });
const createResult = (toolUseId: string, n: string, subject: string): ChatEvent =>
  ({ type: "tool_result", output: `Task #${n} created successfully: ${subject}`, toolUseId });
const update = (taskId: string, status: string): ChatEvent =>
  ({ type: "tool_use", tool: "TaskUpdate", input: { taskId, status }, toolUseId: `u-${taskId}-${status}` });
const stop = (taskId: string): ChatEvent =>
  ({ type: "tool_use", tool: "TaskStop", input: { taskId }, toolUseId: `s-${taskId}` });

const ids = (t: TaskItem[]) => t.map((x) => x.id);

describe("aggregateTasks", () => {
  it("folds create -> in_progress -> completed", () => {
    const msgs = [asst([
      create("tu1", "A"), createResult("tu1", "1", "A"),
      update("1", "in_progress"), update("1", "completed"),
    ])];
    expect(aggregateTasks(msgs)).toEqual([{ id: "1", subject: "A", status: "completed" }]);
  });

  it("orders multiple tasks by numeric id (not lexicographic)", () => {
    const msgs = [asst([
      create("a", "two"), createResult("a", "2", "two"),
      create("b", "ten"), createResult("b", "10", "ten"),
      create("c", "one"), createResult("c", "1", "one"),
    ])];
    expect(ids(aggregateTasks(msgs))).toEqual(["1", "2", "10"]);
  });

  it("marks TaskStop as stopped", () => {
    const msgs = [asst([create("tu1", "A"), createResult("tu1", "1", "A"), stop("1")])];
    expect(aggregateTasks(msgs)[0]!.status).toBe("stopped");
  });

  it("seeds a placeholder for an update with no prior create, backfills subject later", () => {
    const early = [asst([update("5", "in_progress")])];
    expect(aggregateTasks(early)).toEqual([{ id: "5", subject: "", status: "in_progress" }]);

    const backfilled = [asst([
      update("5", "in_progress"),
      create("late", "Five"), createResult("late", "5", "Five"),
    ])];
    expect(aggregateTasks(backfilled)).toEqual([{ id: "5", subject: "Five", status: "in_progress" }]);
  });

  it("removes a task when TaskUpdate status is deleted", () => {
    const one = [asst([create("tu1", "A"), createResult("tu1", "1", "A"), update("1", "deleted")])];
    expect(aggregateTasks(one)).toEqual([]);

    const many = [asst([
      create("a", "one"), createResult("a", "1", "one"),
      create("b", "two"), createResult("b", "2", "two"),
      update("1", "deleted"),
    ])];
    expect(aggregateTasks(many)).toEqual([{ id: "2", subject: "two", status: "pending" }]);
  });

  it("returns [] for empty input and for only non-Task tools", () => {
    expect(aggregateTasks([])).toEqual([]);
    const other = [asst([
      { type: "tool_use", tool: "Read", input: { file_path: "/x" }, toolUseId: "r" },
      { type: "tool_use", tool: "TodoWrite", input: { todos: [] }, toolUseId: "td" },
    ])];
    expect(aggregateTasks(other)).toEqual([]);
  });

  it("pairs create + result across separate messages", () => {
    const msgs = [
      asst([create("tu1", "A")], "m1"),
      asst([createResult("tu1", "1", "A"), update("1", "in_progress")], "m2"),
    ];
    expect(aggregateTasks(msgs)).toEqual([{ id: "1", subject: "A", status: "in_progress" }]);
  });

  it("is last-write-wins in stream order", () => {
    const msgs = [asst([
      create("tu1", "A"), createResult("tu1", "1", "A"),
      update("1", "completed"), update("1", "in_progress"),
    ])];
    expect(aggregateTasks(msgs)[0]!.status).toBe("in_progress");
  });
});
