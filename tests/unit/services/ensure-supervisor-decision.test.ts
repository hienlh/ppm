import { describe, expect, it } from "bun:test";
import {
  decideEnsure, MAX_MEMORY_WAIT_MS, MAX_STARTS, START_WINDOW_MS, UPGRADE_GRACE_MS, type EnsureFacts,
} from "../../../src/services/supervisor-watchdog/ensure-supervisor-decision.ts";

const NOW = 10_000_000_000;
const BOOT = NOW - 5 * 60 * 60_000;
const facts = (over: Partial<EnsureFacts> = {}): EnsureFacts => ({
  now: NOW,
  bootAt: BOOT,
  statusState: "running",
  supervisorAlive: false,
  state: { starts: [], bootHandledAt: BOOT + 1000 },
  memoryExhausted: false,
  ...over,
});

describe("decideEnsure", () => {
  it("does nothing while the supervisor runs, and marks the boot handled", () => {
    const r = decideEnsure(facts({ supervisorAlive: true, state: { starts: [] } }));
    expect(r.decision).toEqual({ action: "none", reason: "running" });
    expect(r.state.bootHandledAt).toBe(NOW);
  });

  it("starts PPM when its last run died, and records the start", () => {
    const r = decideEnsure(facts());
    expect(r.decision).toEqual({ action: "start", why: "died" });
    expect(r.state.starts).toEqual([NOW]);
  });

  it("leaves a PPM someone took down alone, until the next boot", () => {
    expect(decideEnsure(facts({ statusState: null })).decision).toEqual({ action: "none", reason: "not-wanted" });
    expect(decideEnsure(facts({ statusState: "stopped" })).decision).toEqual({ action: "none", reason: "not-wanted" });
    // First run since the machine started: logon has always started PPM.
    expect(decideEnsure(facts({ statusState: null, state: { starts: [], bootHandledAt: BOOT - 1 } })).decision).toEqual({ action: "start", why: "boot" });
    expect(decideEnsure(facts({ statusState: null, state: { starts: [] } })).decision).toEqual({ action: "start", why: "boot" });
  });

  it("does not take a fresh upgrade swap for a death", () => {
    expect(decideEnsure(facts({ statusState: "upgrading", statusAgeMs: UPGRADE_GRACE_MS - 1 })).decision).toEqual({ action: "none", reason: "upgrading" });
    expect(decideEnsure(facts({ statusState: "upgrading", statusAgeMs: UPGRADE_GRACE_MS })).decision).toEqual({ action: "start", why: "died" });
  });

  it("waits for memory after a death, then starts anyway after the longest wait", () => {
    const first = decideEnsure(facts({ memoryExhausted: true }));
    expect(first.decision).toEqual({ action: "wait", reason: "low-memory", waitedMs: 0 });
    expect(first.state.waitingSince).toBe(NOW);

    const later = decideEnsure(facts({ now: NOW + 120_000, memoryExhausted: true, state: first.state }));
    expect(later.decision).toEqual({ action: "wait", reason: "low-memory", waitedMs: 120_000 });

    const recovered = decideEnsure(facts({ now: NOW + 240_000, memoryExhausted: false, state: later.state }));
    expect(recovered.decision).toEqual({ action: "start", why: "died", afterWaitMs: 240_000 });
    expect(recovered.state.waitingSince).toBeUndefined();

    const tooLong = decideEnsure(facts({ now: NOW + MAX_MEMORY_WAIT_MS, memoryExhausted: true, state: first.state }));
    expect(tooLong.decision).toEqual({ action: "start", why: "died", afterWaitMs: MAX_MEMORY_WAIT_MS });
  });

  it("does not wait for memory at boot", () => {
    expect(decideEnsure(facts({ memoryExhausted: true, state: { starts: [] } })).decision.action).toBe("start");
  });

  it("does not restart a PPM being taken down (ppm stop --kill marks it stopping first)", () => {
    expect(decideEnsure(facts({ statusState: "stopping" })).decision).toEqual({ action: "none", reason: "not-wanted" });
  });

  it("gives up once after too many starts in the window, and tries again once they age out", () => {
    const starts = Array.from({ length: MAX_STARTS }, (_, i) => NOW - 60_000 * (MAX_STARTS - i));
    const gaveUp = decideEnsure(facts({ state: { starts, bootHandledAt: BOOT + 1 } }));
    expect(gaveUp.decision).toEqual({ action: "give-up", starts: MAX_STARTS });
    expect(decideEnsure(facts({ now: NOW + 120_000, state: gaveUp.state })).decision).toEqual({ action: "none", reason: "gave-up" });
    const aged = decideEnsure(facts({ now: NOW + START_WINDOW_MS, state: gaveUp.state }));
    expect(aged.decision.action).toBe("start");
  });
});
