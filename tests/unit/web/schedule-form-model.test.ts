/** The schedule form's body and checks: a blank secret keeps the saved one, and the server's rules apply. */
import { describe, expect, it } from "bun:test";
import {
  draftsToDecls, formProblems, initialForm, requestBody, withKind, type ScheduleFormState,
} from "../../../src/web/lib/schedule-form-model";
import type { ScheduleView } from "../../../src/types/scheduler";

/** An always-on script as GET /api/schedules/:id answers it, its token saved. */
const saved: ScheduleView = {
  id: 3, name: "Support bot", description: "Watches the inbox", kind: "script", mode: "always-on",
  cron_expr: "", provider_id: "mock", project_path: "/work/demo", prompt: "",
  script: "export default async (ctx) => {}\n", permission_mode: "bypassPermissions", max_turns: null,
  timeout_ms: 300_000, enabled: 0, session_id: null, last_run_at: null, next_fire_at: null,
  created_at: "2026-10-12 00:00:00", updated_at: "2026-10-12 00:00:00",
  inputs: [
    { key: "channel", label: "Channel", type: "text", default: "#support" },
    { key: "pollSeconds", label: "Poll seconds", type: "number", default: 30 },
    { key: "dryRun", label: "Dry run", type: "boolean", default: true },
    { key: "token", label: "Slack token", type: "secret", required: true },
  ],
  inputValues: { channel: "#ops" },
  secretsSet: ["token"],
  status: { state: "stopped", pid: null, since: null, restartAt: null, restarts: 0, lastError: null },
};

const form = (over: Partial<ScheduleFormState> = {}): ScheduleFormState => ({ ...initialForm(saved), ...over });

describe("requestBody", () => {
  it("an edit sends every value, null for a cleared one, and no secret unless one was typed", () => {
    const body = requestBody(form({ values: { channel: "", pollSeconds: "45", dryRun: "true" } }), true);
    expect(body).toEqual({
      name: "Support bot", description: "Watches the inbox", project_path: "/work/demo",
      permission_mode: "bypassPermissions", enabled: false, mode: "always-on",
      script: "export default async (ctx) => {}\n",
      inputs: saved.inputs,
      inputValues: { channel: null, pollSeconds: 45, dryRun: true },
    });
    expect(body).not.toHaveProperty("kind");
    expect(body).not.toHaveProperty("secrets");
    expect(body).not.toHaveProperty("cron_expr");
    expect(body).not.toHaveProperty("timeout_ms");
  });

  it("a secret typed now is sent, and only that one", () => {
    const body = requestBody(form({ secrets: { token: "xoxp-new", stray: "not declared" } }), true);
    expect(body.secrets).toEqual({ token: "xoxp-new" });
  });

  it("a new prompt schedule sends its kind, cron, timeout and an empty max turns as null", () => {
    const body = requestBody({ ...initialForm(null), name: " Daily ", projectPath: "/p", prompt: "Summarise" }, false);
    expect(body).toEqual({
      name: "Daily", description: "", project_path: "/p", permission_mode: "bypassPermissions", enabled: true,
      mode: "tick", kind: "prompt", cron_expr: "0 7 * * *", timeout_ms: 1_800_000, prompt: "Summarise", max_turns: null,
    });
  });
});

describe("withKind", () => {
  it("moves an untouched timeout to the kind's default, keeps a typed one, and puts a prompt on tick", () => {
    expect(withKind(initialForm(null), "script").timeoutMs).toBe("300000");
    expect(withKind({ ...initialForm(null), timeoutMs: "60000" }, "script").timeoutMs).toBe("60000");
    expect(withKind({ ...initialForm(null), kind: "script", mode: "always-on" }, "prompt").mode).toBe("tick");
  });
});

describe("draftsToDecls", () => {
  it("types each default, drops a secret's, trims, and leaves out what is empty", () => {
    expect(draftsToDecls([
      { key: " n ", label: " N ", type: "number", required: false, default: "30", description: "" },
      { key: "b", label: "B", type: "boolean", required: true, default: "false", description: " d " },
      { key: "s", label: "S", type: "secret", required: true, default: "leak", description: "" },
    ])).toEqual([
      { key: "n", label: "N", type: "number", default: 30 },
      { key: "b", label: "B", type: "boolean", required: true, default: false, description: "d" },
      { key: "s", label: "S", type: "secret", required: true },
    ]);
  });
});

describe("formProblems", () => {
  it("is empty for a valid schedule, and names what is missing", () => {
    expect(formProblems(form(), ["token"])).toEqual([]);
    expect(formProblems(form({ name: " ", projectPath: "" }), ["token"])).toEqual(["Give the schedule a name", "Pick a project"]);
  });

  it("applies the server's cron rules: 5 fields for a prompt, seconds allowed for a script, never under 5 s", () => {
    const prompt = { ...initialForm(null), name: "p", projectPath: "/p", prompt: "x" };
    expect(formProblems({ ...prompt, cron: "*/30 * * * * *" })).toEqual(["A prompt schedule takes 5 cron fields: minute hour day month weekday"]);
    expect(formProblems(form({ mode: "tick", cron: "*/30 * * * * *", timeoutMs: "60000" }), ["token"])).toEqual([]);
    expect(formProblems(form({ mode: "tick", cron: "* * * * * *", timeoutMs: "60000" }), ["token"])).toEqual(["A schedule may fire at most every 5 seconds"]);
  });

  it("asks for a required secret only when the schedule is turned on and none is saved or typed", () => {
    const on = form({ enabled: true });
    expect(formProblems(on, [])).toEqual(["Fill in token before turning it on"]);
    expect(formProblems(on, ["token"])).toEqual([]);
    expect(formProblems({ ...on, secrets: { token: "typed" } }, [])).toEqual([]);
    expect(formProblems(form({ enabled: false }), [])).toEqual([]);
  });

  it("names a value that is not a number", () => {
    expect(formProblems(form({ values: { pollSeconds: "soon" } }), ["token"])).toEqual(["Poll seconds must be a number"]);
  });
});

describe("scheduleStatusLabel", () => {
  it("counts down to an always-on restart, and says on or off for the rest", async () => {
    const { scheduleStatusLabel } = await import("../../../src/web/components/settings/schedules/schedule-status-chip");
    const now = Date.parse("2026-10-12T10:00:00Z");
    const restarting = { ...saved, status: { ...saved.status, state: "restarting" as const, restartAt: "2026-10-12T10:00:19.200Z" } };
    expect(scheduleStatusLabel(restarting, now)).toEqual({ text: "Restarting in 20 s", tone: "wait" });
    expect(scheduleStatusLabel(saved, now).text).toBe("Stopped");
    expect(scheduleStatusLabel({ ...saved, enabled: 1, status: { ...saved.status, state: "idle" } }, now).text).toBe("Enabled");
    expect(scheduleStatusLabel({ ...saved, status: { ...saved.status, state: "blocked", pid: 42 } }, now).text).toBe("Blocked");
  });
});

describe("a session schedule (Chat)", () => {
  const CHAT = "aaaaaaaa-0000-4000-8000-000000000001";
  const chat = (over: Partial<ScheduleFormState> = {}): ScheduleFormState => ({
    ...withKind(initialForm(null), "session"),
    projectPath: "/work/demo", targetSessionId: CHAT, prompt: "Check the build", cron: "0 8 * * *",
    ...over,
  });

  it("asks for a project and a chat, by name, before anything is sent", () => {
    const problems = formProblems(chat({ projectPath: "", targetSessionId: "" }));
    expect(problems).toContain("Pick a project");
    expect(problems).toContain("Pick a chat");
  });

  it("is checked by the shared rules: prompt, 5-field cron and an IANA zone; the name may be left out", () => {
    expect(formProblems(chat())).toEqual([]);
    expect(formProblems(chat({ prompt: "  " }))).toContain("A session schedule needs a prompt");
    expect(formProblems(chat({ cron: "*/30 * * * * *" }))[0]).toContain("5 cron fields");
    expect(formProblems(chat({ timezone: "Mars/Olympus" }))[0]).toContain("IANA time zone");
    expect(formProblems(chat({ timezone: "Europe/London" }))).toEqual([]);
  });

  it("sends only what a session schedule has, and its chat only when it is created", () => {
    const created = requestBody(chat({ timezone: " Europe/London ", recurring: false }), false);
    expect(created).toEqual({
      name: "", prompt: "Check the build", cron_expr: "0 8 * * *", timezone: "Europe/London",
      recurring: false, enabled: true, kind: "session", target_session_id: CHAT,
    });
    for (const key of ["permission_mode", "max_turns", "timeout_ms", "project_path", "mode"]) expect(created).not.toHaveProperty(key);
    const edited = requestBody(chat({ timezone: "" }), true);
    expect(edited).not.toHaveProperty("kind");
    expect(edited).not.toHaveProperty("target_session_id");
    expect(edited.timezone).toBeNull();
  });

  it("reads a saved one back with its chat, zone and one-shot flag", () => {
    const view = {
      ...saved, kind: "session" as const, mode: "tick" as const, script: null, inputs: [], inputValues: {}, secretsSet: [],
      target_session_id: CHAT, timezone: "Asia/Saigon", recurring: 0, pending_since: null, paused_reason: null,
    };
    expect(initialForm(view)).toMatchObject({ kind: "session", targetSessionId: CHAT, timezone: "Asia/Saigon", recurring: false });
  });

  it("says a session schedule is active, waiting for its chat, paused or off", async () => {
    const { scheduleStatusLabel } = await import("../../../src/web/components/settings/schedules/schedule-status-chip");
    const base = { ...saved, kind: "session" as const, enabled: 1, pending_since: null, paused_reason: null, timezone: null };
    expect(scheduleStatusLabel(base, 0)).toEqual({ text: "Active", tone: "ok" });
    expect(scheduleStatusLabel({ ...base, pending_since: "2026-11-15T08:00:00Z" }, 0)).toEqual({ text: "Waiting for the chat", tone: "wait" });
    // Held after the user pressed Stop in its chat: the chip and Settings say why it waits.
    expect(scheduleStatusLabel({ ...base, pending_since: "2026-11-15T08:00:00Z", held_after_stop: true }, 0)).toEqual({ text: "Held after Stop", tone: "wait" });
    const { sessionScheduleStatus } = await import("../../../src/web/lib/session-schedule-view");
    expect(sessionScheduleStatus({ ...base, pending_since: "2026-11-15T08:00:00Z", held_after_stop: true }).detail)
      .toContain("held after Stop until the chat's next turn ends or the next fire");
    // Not due, nothing to hold.
    expect(scheduleStatusLabel({ ...base, held_after_stop: true }, 0)).toEqual({ text: "Active", tone: "ok" });
    expect(scheduleStatusLabel({ ...base, enabled: 0, paused_reason: "Its chat is gone." }, 0)).toEqual({ text: "Paused", tone: "bad" });
    expect(scheduleStatusLabel({ ...base, enabled: 0 }, 0)).toEqual({ text: "Off", tone: "off" });
  });
});

describe("session schedule wording", () => {
  it("puts common crons into words and leaves the rest as written", async () => {
    const { describeCron, zoneCity } = await import("../../../src/web/lib/session-schedule-view");
    expect(describeCron("0 8 * * *")).toBe("Daily at 08:00");
    expect(describeCron("30 9 * * 1-5")).toBe("Weekdays at 09:30");
    expect(describeCron("0 9 * * 1,3")).toBe("Mon, Wed at 09:00");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("5 * * * *")).toBe("Hourly at :05");
    expect(describeCron("0 7 1 * *")).toBe("Monthly on day 1 at 07:00");
    expect(describeCron("0 8 15 11 *")).toBe("Nov 15 at 08:00");
    expect(describeCron("0 8-17/2 * * *")).toBe("0 8-17/2 * * *");
    expect(zoneCity("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
  });
});
