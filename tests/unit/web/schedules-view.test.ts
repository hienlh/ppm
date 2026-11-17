/**
 * How the Schedules window reads its list: filters by project and chip, groups (attention first,
 * then the next 24 hours, later, off), and the words for next and last runs — a chat reminder on
 * its own clock ("18:30 London"), everything else on the device's.
 */
import { describe, expect, it } from "bun:test";
import {
  chipCounts, clockLabel, DEFAULT_FILTER, filterSchedules, groupSchedules, lastRunLabel, nextRunLabel, projectLabel, projectsOf, relativeIn,
} from "../../../src/web/lib/schedules/schedules-view.ts";
import type { ScheduleOverview } from "../../../src/types/scheduler.ts";

const NOW = Date.parse("2026-11-17T10:20:00Z");
const iso = (ms: number) => new Date(NOW + ms).toISOString();
const H = 3_600_000;

let nextId = 1;
const row = (over: Partial<ScheduleOverview> = {}): ScheduleOverview => ({
  id: nextId++, name: "Nightly", cron_expr: "0 2 * * *", provider_id: "claude", project_path: "/w/alpha", prompt: "run tests",
  permission_mode: "bypassPermissions", max_turns: null, timeout_ms: 30 * 60_000, enabled: 1, session_id: null, last_run_at: null,
  next_fire_at: iso(8 * H), created_at: "", updated_at: "", kind: "prompt", mode: "tick", description: "", script: null,
  target_session_id: null, timezone: null, recurring: 1, pending_since: null, paused_reason: null, task_id: null, attention_dismissed: null,
  inputs: [], inputValues: {}, secretsSet: [], status: { state: "idle", pid: null, since: null, restartAt: null, restarts: 0, lastError: null },
  last_run: null, project_name: "alpha", effective_permission_mode: "bypassPermissions", next_fires: [], task: null,
  ...over,
} as ScheduleOverview);

const failed = row({ name: "Failing", last_run: { id: 9, status: "error", started_at: "2026-11-17 02:00:00", ended_at: iso(-8 * H), error: "Timed out\nstack", session_id: "s" } });
const soon = row({ name: "Soon", project_path: "/w/beta", project_name: "beta", effective_permission_mode: "acceptEdits", next_fire_at: iso(2 * H) });
const later = row({ name: "Weekly", next_fire_at: iso(3 * 24 * H) });
const off = row({ name: "Off one", enabled: 0, project_path: "/w/beta", project_name: "beta" });
const reminder = row({
  name: "Remind PR", kind: "session", project_path: "/w/beta", project_name: "beta", timezone: "Europe/London", recurring: 0,
  cron_expr: "30 18 17 11 *", next_fire_at: "2026-11-17T18:30:00.000Z", target_title: "QL beta",
  task: { id: "t", ref: "beta/12", title: "Review PR", project: "beta", closed: false },
});
const all = [failed, soon, later, off, reminder];

describe("filters and chips", () => {
  it("filters by project and by chip, and counts each chip inside the chosen project", () => {
    expect(projectsOf(all)).toEqual(["alpha", "beta"]);
    expect(filterSchedules(all, { ...DEFAULT_FILTER, project: "beta" }, NOW).map((s) => s.name)).toEqual(["Soon", "Off one", "Remind PR"]);
    expect(filterSchedules(all, { ...DEFAULT_FILTER, chip: "attention" }, NOW).map((s) => s.name)).toEqual(["Failing"]);
    expect(filterSchedules(all, { ...DEFAULT_FILTER, chip: "bypass" }, NOW).map((s) => s.name)).toEqual(["Failing", "Weekly", "Remind PR"]);
    expect(chipCounts(all, null, NOW)).toEqual({ all: 5, upcoming: 3, attention: 1, bypass: 3, off: 1 });
    expect(chipCounts(all, "beta", NOW)).toEqual({ all: 3, upcoming: 2, attention: 0, bypass: 1, off: 1 });
  });

  it("searches names, prompts, chats and task references", () => {
    expect(filterSchedules(all, { ...DEFAULT_FILTER, query: "beta/12" }, NOW).map((s) => s.name)).toEqual(["Remind PR"]);
    expect(filterSchedules(all, { ...DEFAULT_FILTER, query: "ql beta" }, NOW).map((s) => s.name)).toEqual(["Remind PR"]);
  });

  it("names a project by its folder when it is not registered", () => {
    expect(projectLabel({ project_name: null, project_path: "C:\\work\\gamma" })).toBe("gamma");
  });
});

describe("groupSchedules", () => {
  it("puts attention first, then the next 24 hours soonest first, then later, then off", () => {
    expect(groupSchedules(all, NOW).map((g) => [g.id, g.items.map((s) => s.name)])).toEqual([
      ["attention", ["Failing"]], ["upcoming", ["Soon", "Remind PR"]], ["later", ["Weekly"]], ["off", ["Off one"]],
    ]);
  });
});

describe("run labels", () => {
  it("reads a reminder on its own zone's clock and says it fires once", () => {
    expect(nextRunLabel(reminder, NOW, "Asia/Saigon")).toEqual({ main: "18:30 London", sub: "in 8h 10m · once" });
  });

  it("drops the zone when it is the device's own", () => {
    expect(clockLabel(Date.parse("2026-11-17T18:30:00Z"), "Europe/London", NOW, "Europe/London")).toBe("18:30");
  });

  it("names the day when it is not today", () => {
    expect(clockLabel(NOW + 20 * H, null, NOW, "UTC")).toMatch(/^tomorrow \d\d:\d\d/);
    expect(clockLabel(NOW + 3 * 24 * H, null, NOW, "UTC")).toMatch(/^[A-Z][a-z]{2} \d\d:\d\d$/);
  });

  it("says why there is no next run", () => {
    expect(nextRunLabel(off, NOW).main).toBe("Off");
    expect(nextRunLabel(row({ kind: "session", pending_since: iso(-60_000) }), NOW).main).toBe("Due now");
    expect(nextRunLabel(row({ mode: "always-on", next_fire_at: null }), NOW).main).toBe("Always on");
  });

  it("gives a failed run's first error line, and reads SQLite's stamps as UTC", () => {
    expect(lastRunLabel(failed, NOW)).toEqual({ tone: "bad", text: "Timed out", when: "8h ago" });
    expect(lastRunLabel(soon, NOW)).toEqual({ tone: "none", text: "Not run yet", when: "" });
  });

  it("counts down in minutes, hours and days", () => {
    expect(relativeIn(NOW + 3 * 60_000, NOW)).toBe("in 3m");
    expect(relativeIn(NOW + 8 * H + 10 * 60_000, NOW)).toBe("in 8h 10m");
    expect(relativeIn(NOW + 70 * H, NOW)).toBe("in 2d 22h");
  });
});
