import { describe, it, expect } from "bun:test";
import { cronProblem, nextFires, SCRIPT_MIN_INTERVAL_MS } from "../../../src/shared/schedule-cron.ts";

describe("cronProblem", () => {
  it("a prompt keeps the 5-field form", () => {
    expect(cronProblem("*/5 * * * *", "prompt")).toBeNull();
    expect(cronProblem("0 */5 * * * *", "prompt")).toContain("5 cron fields");
  });

  it("a script may add a seconds field, down to every 5 seconds", () => {
    expect(cronProblem("*/15 * * * * *", "script")).toBeNull();
    expect(cronProblem("*/5 * * * * *", "script")).toBeNull();
    expect(cronProblem("0 * * * *", "script")).toBeNull();
  });

  it("a script firing faster than every 5 seconds is refused", () => {
    expect(cronProblem("*/3 * * * * *", "script")).toContain(`every ${SCRIPT_MIN_INTERVAL_MS / 1000} seconds`);
    expect(cronProblem("* * * * * *", "script")).not.toBeNull();
  });

  it("the shortest gap counts, not the average one", () => {
    // Fires at :00 and :02 of every minute: 2 s apart, then 58 s.
    expect(cronProblem("0,2 * * * * *", "script")).not.toBeNull();
  });

  it("anything that does not parse, or has the wrong number of fields, is refused", () => {
    expect(cronProblem("every minute", "script")).not.toBeNull();
    expect(cronProblem("61 * * * *", "prompt")).toContain("Invalid cron");
    expect(cronProblem("* * * *", "script")).toContain("5 cron fields");
    expect(cronProblem("0 0 0 * * * *", "script")).toContain("5 cron fields");
  });
});

describe("nextFires", () => {
  it("lists the next fires, seconds included", () => {
    const from = new Date("2026-10-12T10:00:01.000Z");
    const fires = nextFires("*/15 * * * * *", 3, from);
    expect(fires.map((d) => d.toISOString())).toEqual([
      "2026-10-12T10:00:15.000Z",
      "2026-10-12T10:00:30.000Z",
      "2026-10-12T10:00:45.000Z",
    ]);
  });

  it("is empty for an expression that does not parse", () => {
    expect(nextFires("nope", 3)).toEqual([]);
  });
});
