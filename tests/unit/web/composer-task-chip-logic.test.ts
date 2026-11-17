import { describe, expect, it } from "bun:test";
import {
  chipGoesToChat, pickChatTabForSession, readTaskChips, TASK_CHIP_META_KEY, taskChipLabel, taskChipOf, taskChipsFromRefs, withTaskChip, type ComposerTaskChip,
} from "../../../src/web/lib/ppm-tasks/composer-task-chip-logic.ts";
import type { TaskWorkingSession } from "../../../src/shared/ppm-tasks-api.ts";

const chip = (n: number): ComposerTaskChip => ({
  taskId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, number: n, ref: `alpha/${n}`, title: `Task ${n}`, project: "alpha",
});

describe("composer task chip", () => {
  it("reads as Task #N · title", () => {
    expect(taskChipLabel(chip(12), "alpha")).toBe("Task #12 · Task 12");
    expect(taskChipOf({ id: chip(3).taskId, number: 3, ref: "alpha/3", title: "Task 3", project: "alpha", ...{ extra: 1 } } as never)).toEqual(chip(3));
  });

  it("an edited or forked message's task block comes back as its chips", () => {
    const ref = { version: 1 as const, taskId: chip(7).taskId, ref: "alpha/7", number: 7, projectName: "alpha", title: "Task 7",
      status: "To do", urgency: "now" as const, due: null, link: "http://localhost/x" };
    expect(taskChipsFromRefs([ref])).toEqual([chip(7)]);
    expect(taskChipsFromRefs(null)).toEqual([]);
  });

  it("reads only well-formed chips from tab metadata", () => {
    expect(readTaskChips(undefined)).toEqual([]);
    expect(readTaskChips({ [TASK_CHIP_META_KEY]: "x" })).toEqual([]);
    expect(readTaskChips({ [TASK_CHIP_META_KEY]: [chip(1), { taskId: "nope", number: 1 }, null] })).toEqual([chip(1)]);
  });

  it("puts the newest task first, each task once, at most five", () => {
    expect(withTaskChip([chip(1), chip(2)], chip(1))).toEqual([chip(1), chip(2)]);
    expect(withTaskChip([chip(1)], chip(2))).toEqual([chip(2), chip(1)]);
    const many = [1, 2, 3, 4, 5].map(chip);
    expect(withTaskChip(many, chip(6)).map((c) => c.number)).toEqual([6, 1, 2, 3, 4]);
  });

  it("gives the chip to the chat tab of that session the user sees, else the newest used", () => {
    const tab = (id: string, sessionId: string, lastActiveAt: number, type = "chat") => ({ id, type, metadata: { sessionId, lastActiveAt } });
    const tabs = [
      { tab: tab("a", "s1", 10), selected: false, focused: false },
      { tab: tab("b", "s1", 30), selected: false, focused: false },
      { tab: tab("c", "s2", 99), selected: true, focused: true },
      { tab: tab("d", "s1", 50, "design"), selected: true, focused: true },
    ];
    expect(pickChatTabForSession(tabs, "s1")).toBe("b");
    expect(pickChatTabForSession([...tabs, { tab: tab("e", "s1", 1), selected: true, focused: false }], "s1")).toBe("e");
    expect(pickChatTabForSession(tabs, "missing")).toBeNull();
  });
});

describe("which chat a task's chip goes to", () => {
  const state = (sessionId: string) => ({ sessionId, state: "idle" as const, title: null, providerId: "claude" });
  const task = (workingSession: TaskWorkingSession) => ({ project: "alpha", workingSession });
  const managers = [{ projectName: "alpha", sessionId: "mgr-alpha" }, { projectName: "beta", sessionId: "mgr-beta" }];

  it("the project's manager chat takes it: it works on many tasks", () => {
    const viaManager = task({ kind: "manager", label: "Manager", session: state("mgr-alpha") });
    expect(chipGoesToChat(viaManager, "mgr-alpha", managers)).toBe(true);
    // Before the manager list has loaded, the task's own working session says so.
    expect(chipGoesToChat(viaManager, "mgr-alpha", null)).toBe(true);
    // A task handed to the manager chat itself is still the manager's.
    expect(chipGoesToChat(task({ kind: "session", session: state("mgr-alpha") }), "mgr-alpha", managers)).toBe(true);
  });

  it("a chat the task was handed off to does not: it works on that task alone", () => {
    const handedOff = task({ kind: "session", session: state("child-1") });
    expect(chipGoesToChat(handedOff, "child-1", managers)).toBe(false);
    expect(chipGoesToChat(handedOff, "child-1", null)).toBe(false);
    // Another project's manager is not this task's manager.
    expect(chipGoesToChat(task({ kind: "session", session: state("mgr-beta") }), "mgr-beta", managers)).toBe(false);
  });

  it("a task with no chat yet: only the manager chat it would open takes it", () => {
    // No chat handed the task: the working session is the manager.
    expect(chipGoesToChat(task({ kind: "manager", label: "Manager", session: state("mgr-alpha") }), "mgr-alpha", managers)).toBe(true);
    // No manager either: the chat Start chat opens is the task's own.
    expect(chipGoesToChat(task({ kind: "start_chat" }), "new-chat", [])).toBe(false);
    expect(chipGoesToChat(task({ kind: "start_chat" }), "new-chat", null)).toBe(false);
  });

  it("goes by session id, never by the chat's title", () => {
    const named = task({ kind: "session", session: { ...state("child-2"), title: "Manager" } });
    expect(chipGoesToChat(named, "child-2", managers)).toBe(false);
  });
});
