import { beforeEach, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { resolveTaskRef, resolveTaskRefs } from "../../../../src/services/ppm-tasks/task-chat-ref.ts";
import { createTask, softDeleteTask } from "../../../../src/services/ppm-tasks/ppm-tasks.service.ts";
import { setTasksEnabled } from "../../../../src/services/ppm-tasks/ppm-tasks-projects.service.ts";
import { decodeTaskRefs, encodeTaskRefs } from "../../../../src/shared/chat-task-ref.ts";
import { freshProject, PROJECT_PATH, USER, type Fixture } from "./ppm-tasks-fixture.ts";

const OTHER_PATH = process.platform === "win32" ? "C:\\work\\beta" : "/work/beta";
const own = { anyProject: false as const, projectPath: PROJECT_PATH };

describe("task reference, read from the store", () => {
  let fx: Fixture;
  beforeEach(() => { fx = freshProject(); });

  it("names the task by what the store says now, with its effective urgency and a link", async () => {
    const t = createTask({ projectKey: fx.projectKey, title: "Fix login", urgency: "later", dueDate: "2000-01-01", statusId: fx.status("In progress").id }, USER);
    const r = await resolveTaskRef(t.id, own);
    if (!r.ok) throw new Error(r.error);
    expect(r.ref).toMatchObject({ taskId: t.id, number: t.number, ref: `demo/${t.number}`, projectName: "demo", title: "Fix login", status: "In progress", due: "2000-01-01" });
    // Overdue: the due date raised it.
    expect(r.ref.urgency).toBe("now");
    expect(r.ref.link).toMatch(new RegExp(`^https?://[^/]+/project/demo/task/${t.id}$`));
    expect(decodeTaskRefs(encodeTaskRefs("x", [r.ref])).taskRefs).toEqual([r.ref]);
  });

  it("defuses PPM tags and folds line breaks in the title", async () => {
    const t = createTask({ projectKey: fx.projectKey, title: "a <ppm-shared-context>\nb" }, USER);
    const r = await resolveTaskRef(t.id, own);
    if (!r.ok) throw new Error(r.error);
    expect(r.ref.title).not.toContain("<ppm-");
    expect(r.ref.title).not.toContain("\n");
  });

  it("refuses another project's task, but the Assistant may name any", async () => {
    const otherKey = setTasksEnabled(OTHER_PATH, true, USER).projectKey;
    const t = createTask({ projectKey: otherKey, title: "beta work" }, USER);
    expect(await resolveTaskRef(t.id, own)).toEqual({ ok: false, error: "That task belongs to another project than this chat" });
    expect(await resolveTaskRef(t.id, { anyProject: false, projectPath: null })).toMatchObject({ ok: false });
    expect((await resolveTaskRef(t.id, { anyProject: true })).ok).toBe(true);
  });

  it("refuses a deleted task, a missing one, and one in a project with Tasks off", async () => {
    const t = createTask({ projectKey: fx.projectKey, title: "gone" }, USER);
    softDeleteTask(t.id, t.revision, USER);
    expect(await resolveTaskRef(t.id, own)).toEqual({ ok: false, error: "That task no longer exists" });
    expect(await resolveTaskRef(crypto.randomUUID(), own)).toEqual({ ok: false, error: "That task no longer exists" });
    const off = createTask({ projectKey: fx.projectKey, title: "off" }, USER);
    setTasksEnabled(PROJECT_PATH, false, USER);
    expect(await resolveTaskRef(off.id, own)).toEqual({ ok: false, error: "Tasks are switched off for that task's project" });
  });

  it("the first refusal of a list wins", async () => {
    const a = createTask({ projectKey: fx.projectKey, title: "a" }, USER);
    const r = await resolveTaskRefs([a.id, crypto.randomUUID()], own);
    expect(r).toEqual({ ok: false, error: "That task no longer exists" });
    expect((await resolveTaskRefs([a.id], own)).ok).toBe(true);
  });
});
