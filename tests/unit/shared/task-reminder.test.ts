/**
 * A task reminder's moment: a local date and time read on a named zone's clock, turned into a
 * one-shot cron and back, and into the instant it names — across a DST change too.
 */
import { describe, expect, it } from "bun:test";
import {
  localMomentText, localMomentToEpoch, parseLocalMoment, reminderCron, reminderMomentOf, reminderName, reminderPrompt,
} from "../../../src/shared/task-reminder.ts";

describe("parseLocalMoment", () => {
  it("reads a datetime-local value and refuses dates that do not exist", () => {
    expect(parseLocalMoment("2026-11-17T18:30")).toEqual({ year: 2026, month: 11, day: 17, hour: 18, minute: 30 });
    expect(parseLocalMoment("2026-02-30T10:00")).toBeNull();
    expect(parseLocalMoment("2026-11-17T24:00")).toBeNull();
    expect(parseLocalMoment("2026-11-17 18:30")).toBeNull();
    expect(parseLocalMoment(42)).toBeNull();
  });
});

describe("reminderCron and reminderMomentOf", () => {
  it("pins minute, hour, day and month, and reads them back", () => {
    const at = parseLocalMoment("2026-03-05T07:05")!;
    expect(reminderCron(at)).toBe("5 7 5 3 *");
    expect(reminderMomentOf("5 7 5 3 *")).toEqual({ minute: 5, hour: 7, day: 5, month: 3 });
    expect(reminderMomentOf("*/5 8-18 * * 1-5")).toBeNull();
  });
});

describe("localMomentToEpoch", () => {
  it("names the instant on the zone's clock, winter and summer", () => {
    expect(new Date(localMomentToEpoch(parseLocalMoment("2026-11-17T18:30")!, "Europe/London")).toISOString()).toBe("2026-11-17T18:30:00.000Z");
    expect(new Date(localMomentToEpoch(parseLocalMoment("2026-07-01T18:30")!, "Europe/London")).toISOString()).toBe("2026-07-01T17:30:00.000Z");
    expect(new Date(localMomentToEpoch(parseLocalMoment("2026-11-17T18:30")!, "Asia/Saigon")).toISOString()).toBe("2026-11-17T11:30:00.000Z");
  });

  it("round-trips through localMomentText on the same clock", () => {
    const at = "2026-03-29T09:15";
    expect(localMomentText(new Date(localMomentToEpoch(parseLocalMoment(at)!, "Europe/London")), "Europe/London")).toBe(at);
  });
});

describe("reminderName and reminderPrompt", () => {
  const task = { number: 19, project: "ppm", title: "Review PR 412" };

  it("names the task by its reference and stands on its own", () => {
    expect(reminderName(task)).toBe("Remind: ppm/19 Review PR 412");
    expect(reminderName({ ...task, title: "x".repeat(200) }).length).toBe(100);
    const prompt = reminderPrompt(task, "ask Minh");
    expect(prompt).toContain('task ppm/19 "Review PR 412"');
    expect(prompt).toContain("Note: ask Minh");
    expect(reminderPrompt(task, null)).not.toContain("Note:");
  });
});
