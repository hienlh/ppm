/** The one validator the routes, the CLI and the AI tool share for session schedules. */
import { describe, expect, it } from "bun:test";
import {
  MAX_SCHEDULES_PER_SESSION,
  timezoneProblem,
  validateSessionScheduleInput,
} from "../../../src/shared/session-schedule-input.ts";

const SESSION = "0b6f2c1e-8d7a-4c1b-9f3e-2a5d6e7f8a9b";
const valid = { targetSessionId: SESSION, prompt: "Check the deploy", cron: "0 9 * * 1-5" };

const errorsOf = (raw: Record<string, unknown>) => {
  const check = validateSessionScheduleInput(raw);
  return check.ok ? [] : check.errors;
};

describe("validateSessionScheduleInput", () => {
  it("accepts the smallest valid schedule and fills the defaults", () => {
    const check = validateSessionScheduleInput(valid);
    expect(check).toEqual({
      ok: true,
      value: { targetSessionId: SESSION, name: "Check the deploy", prompt: "Check the deploy", cron: "0 9 * * 1-5", timezone: null, recurring: true },
    });
  });

  it("keeps a given name, a one-shot and a zone in the runtime's own spelling", () => {
    const check = validateSessionScheduleInput({ ...valid, name: "  Standup ", recurring: false, timezone: "asia/saigon", cron: " 30  14 15 11 * " });
    expect(check.ok && check.value).toMatchObject({ name: "Standup", recurring: false, timezone: "Asia/Saigon", cron: "30 14 15 11 *" });
  });

  it("names a schedule after the prompt's first line, cut short", () => {
    const long = "x".repeat(80);
    const check = validateSessionScheduleInput({ ...valid, prompt: `${long}\nsecond line` });
    expect(check.ok && check.value.name).toBe(`${"x".repeat(59)}…`);
  });

  it("refuses a missing or malformed chat id", () => {
    expect(errorsOf({ ...valid, targetSessionId: undefined })).toEqual(["targetSessionId must be the id of an existing chat"]);
    expect(errorsOf({ ...valid, targetSessionId: "../../etc" })).toEqual(["targetSessionId must be the id of an existing chat"]);
  });

  it("refuses an empty or oversized prompt", () => {
    expect(errorsOf({ ...valid, prompt: "   " })).toEqual(["A session schedule needs a prompt"]);
    expect(errorsOf({ ...valid, prompt: "a".repeat(100_001) })).toEqual(["The prompt is longer than 100000 characters"]);
  });

  it("takes 5 cron fields only, and refuses one that does not parse", () => {
    expect(errorsOf({ ...valid, cron: "*/30 * * * * *" })).toEqual(["A session schedule takes 5 cron fields: minute hour day month weekday"]);
    expect(errorsOf({ ...valid, cron: "" })).toEqual(["A session schedule needs a cron expression"]);
    expect(errorsOf({ ...valid, cron: "99 * * * *" })[0]).toStartWith("Invalid cron expression");
  });

  it("refuses a time zone that is not IANA", () => {
    expect(errorsOf({ ...valid, timezone: "Mars/Olympus" })).toEqual(["timezone must be an IANA time zone such as Europe/London"]);
    expect(errorsOf({ ...valid, timezone: 7 })).toEqual(["timezone must be an IANA time zone such as Europe/London"]);
  });

  it("refuses a recurring flag that is not a boolean, and a name that is too long", () => {
    expect(errorsOf({ ...valid, recurring: "no" })).toEqual(["recurring must be true or false"]);
    expect(errorsOf({ ...valid, name: "n".repeat(101) })).toEqual(["name must be text of at most 100 characters"]);
  });

  it("lists every problem at once", () => {
    expect(errorsOf({})).toHaveLength(3);
  });

  it("leaves the settings a session schedule does not have unread", () => {
    expect(validateSessionScheduleInput({ ...valid, permissionMode: "nonsense", maxTurns: -1, timeoutMs: 1 }).ok).toBe(true);
  });
});

describe("timezoneProblem", () => {
  it("treats an absent zone as the machine's own", () => {
    for (const none of [undefined, null, ""]) expect(timezoneProblem(none)).toBeNull();
    expect(timezoneProblem("Europe/London")).toBeNull();
  });
});

it("caps schedules per chat at 20", () => {
  expect(MAX_SCHEDULES_PER_SESSION).toBe(20);
});
