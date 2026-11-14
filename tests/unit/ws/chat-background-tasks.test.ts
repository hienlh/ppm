import { describe, expect, it } from "bun:test";
import {
  BACKGROUND_EVENT_QUIET_MS,
  backgroundEventRecent,
  clearBackgroundTasks,
  hasRunningTasks,
  noteBackgroundEvent,
  noteTaskEvent,
  type BackgroundTaskState,
} from "../../../src/server/ws/chat-background-tasks.ts";

describe("noteTaskEvent", () => {
  it("runs a task from its start to a terminal status on either event", () => {
    const s: BackgroundTaskState = {};
    expect(noteTaskEvent(s, "task_started", "t1", undefined)).toBe(true);
    expect(hasRunningTasks(s)).toBe(true);
    expect(noteTaskEvent(s, "task_updated", "t1", "running")).toBe(false);
    expect(hasRunningTasks(s)).toBe(true);
    expect(noteTaskEvent(s, "task_updated", "t1", "completed")).toBe(true);
    expect(hasRunningTasks(s)).toBe(false);

    noteTaskEvent(s, "task_started", "t2", undefined);
    expect(noteTaskEvent(s, "task_notification", "t2", "killed")).toBe(true);
    expect(hasRunningTasks(s)).toBe(false);
  });

  it("counts a task that already ended as running again when it starts again — an agent resumed by SendMessage", () => {
    const s: BackgroundTaskState = {};
    noteTaskEvent(s, "task_started", "agent", undefined);
    noteTaskEvent(s, "task_notification", "agent", "completed");
    expect(hasRunningTasks(s)).toBe(false);
    expect(noteTaskEvent(s, "task_started", "agent", undefined)).toBe(true);
    expect(hasRunningTasks(s)).toBe(true);
  });

  it("keeps one task running while another ends", () => {
    const s: BackgroundTaskState = {};
    noteTaskEvent(s, "task_started", "a", undefined);
    noteTaskEvent(s, "task_started", "b", undefined);
    noteTaskEvent(s, "task_notification", "a", "failed");
    expect(hasRunningTasks(s)).toBe(true);
  });

  it("ignores events without a task id, and an end for a task it never saw start", () => {
    const s: BackgroundTaskState = {};
    expect(noteTaskEvent(s, "task_started", undefined, undefined)).toBe(false);
    expect(noteTaskEvent(s, "task_notification", "ghost", "completed")).toBe(false);
    expect(hasRunningTasks(s)).toBe(false);
  });
});

describe("background events", () => {
  it("are recent within the quiet window and not after it", () => {
    const s: BackgroundTaskState = {};
    expect(backgroundEventRecent(s, 1_000)).toBe(false);
    noteBackgroundEvent(s, 1_000);
    expect(backgroundEventRecent(s, 1_000 + BACKGROUND_EVENT_QUIET_MS - 1)).toBe(true);
    expect(backgroundEventRecent(s, 1_000 + BACKGROUND_EVENT_QUIET_MS)).toBe(false);
  });
});

describe("clearBackgroundTasks", () => {
  it("forgets running tasks and the last event once the subprocess is gone", () => {
    const s: BackgroundTaskState = {};
    noteTaskEvent(s, "task_started", "a", undefined);
    noteBackgroundEvent(s, 5);
    clearBackgroundTasks(s);
    expect(hasRunningTasks(s)).toBe(false);
    expect(backgroundEventRecent(s, 5)).toBe(false);
  });
});
