import { describe, expect, it } from "bun:test";
import { orderTaskChats, specBar, specProgress, taskCellBySession, taskLabelBySession } from "../../../src/web/lib/spec-family";
import type { SpecSummary } from "../../../src/shared/spec-types";

const spec = (tasks: SpecSummary["tasks"]): SpecSummary => ({
  slug: "s", title: "S", kind: "feature", checks: "thorough", current: "execution",
  tasksDone: tasks.filter((t) => !t.optional && t.status === "done").length, tasksTotal: tasks.filter((t) => !t.optional).length,
  red: 0, running: 0, waitingForYou: false, sessionId: "chat", updatedAt: "", tasks,
});
const T = (id: string, status: SpecSummary["tasks"][number]["status"], sessionId: string | null = null, optional = false) => ({ id, title: `Task ${id}`, status, optional, sessionId });

describe("spec family", () => {
  const s = spec([T("1", "done", "a"), T("2", "red", "b"), T("3", "failed", "c"), T("4", "todo"), T("5", "running", "d", true)]);

  it("draws one bar cell per required task; red counts as running", () => {
    expect(specBar(s)).toEqual(["done", "running", "failed", "todo"]);
    expect(specProgress(s)).toEqual({ done: 1, total: 4, running: 2, failed: 1 });
  });

  it("lists running, then failed, then the rest in their own order", () => {
    const nodes = ["a", "x", "c", "b", "d"].map((id) => ({ session: { id } }));
    expect(orderTaskChats(nodes, taskCellBySession(s)).map((n) => n.session.id)).toEqual(["b", "d", "c", "a", "x"]);
  });

  it("names a task chat by its task, not by the prompt that started it", () => {
    expect(taskLabelBySession(s).get("c")).toBe("3. Task 3");
    expect(taskLabelBySession(s).has("x")).toBe(false);
  });
});
