import { describe, expect, it } from "bun:test";
import {
  advanceClock, describeUnits, idlePastLimit, unitsToStop, type UnitSnapshot,
} from "../../../../src/services/chat-session-processes/leftover-decisions.ts";

const MIN = 60_000;

describe("the idle clock", () => {
  it("starts at the first sighting, so a restart never stops anything early", () => {
    const clock = advanceClock(undefined, 1_000 * MIN, false, 10 * MIN);
    expect(clock.firstSeenAt).toBe(1_000 * MIN);
    expect(idlePastLimit(clock, 1_029 * MIN, false, 30 * MIN)).toBe(false);
    expect(idlePastLimit(clock, 1_030 * MIN, false, 30 * MIN)).toBe(true);
  });

  it("restarts while the session is busy, and from the last turn's end after", () => {
    let clock = advanceClock(undefined, 0, false);
    clock = advanceClock(clock, 50 * MIN, true);
    expect(idlePastLimit(clock, 79 * MIN, false, 30 * MIN)).toBe(false);
    clock = advanceClock(clock, 90 * MIN, false, 85 * MIN);
    expect(clock.lastActiveAt).toBe(85 * MIN);
    expect(idlePastLimit(clock, 114 * MIN, false, 30 * MIN)).toBe(false);
    expect(idlePastLimit(clock, 115 * MIN, false, 30 * MIN)).toBe(true);
  });

  it("never moves back to an older turn end", () => {
    const clock = advanceClock(advanceClock(undefined, 10 * MIN, true), 20 * MIN, false, 5 * MIN);
    expect(clock.lastActiveAt).toBe(10 * MIN);
    expect(advanceClock({ firstSeenAt: 0, lastActiveAt: 40 * MIN }, 50 * MIN, false, 20 * MIN).lastActiveAt).toBe(40 * MIN);
  });

  it("is never past the limit while busy, or when the limit is off", () => {
    const old = { firstSeenAt: 0, lastActiveAt: 0 };
    expect(idlePastLimit(old, 999 * MIN, true, 30 * MIN)).toBe(false);
    expect(idlePastLimit(old, 999 * MIN, false, 0)).toBe(false);
  });
});

describe("unitsToStop", () => {
  const units: UnitSnapshot[] = [
    { name: "ppmcmd-1.scope", comms: ["sleep"], attached: false },
    { name: "ppmcmd-2.scope", comms: ["bun"], attached: true },
    { name: "ppm-tablet-emulator.service", comms: ["qemu-system-x86"], attached: false },
  ];

  it("stops everything the session left once it is idle, never a live command", () => {
    expect(unitsToStop(units, "idle").map((u) => u.name)).toEqual(["ppmcmd-1.scope", "ppm-tablet-emulator.service"]);
  });

  it("at startup stops only what commands left, as a restart did before; an agent's own unit stays", () => {
    expect(unitsToStop(units, "startup").map((u) => u.name)).toEqual(["ppmcmd-1.scope"]);
  });
});

describe("describeUnits", () => {
  it("names an agent's unit, counts repeated processes, and calls a scope a command", () => {
    expect(describeUnits([
      { name: "ppmcmd-1.scope", comms: ["sleep", "sleep"], attached: false },
      { name: "ppm-tablet-emulator.service", comms: ["qemu-system-x86", "netsimd"], attached: false },
    ])).toBe("command (sleep ×2), ppm-tablet-emulator.service (qemu-system-x86, netsimd)");
  });

  it("stays one log line", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ name: `unit-${i}.service`, comms: ["node"], attached: false }));
    const text = describeUnits(many, 100);
    expect(text.length).toBe(100);
    expect(text.endsWith("…")).toBe(true);
  });
});
