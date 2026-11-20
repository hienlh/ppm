import { describe, expect, it } from "bun:test";
import {
  diagnosePreviousRunDeath, oomEventWindow, parseJournalUnixTimes, parseWevtutilTimes,
  OOM_EVENT_AFTER_MS, OOM_EVENT_BEFORE_MS, type PreviousRunFacts,
} from "../../../src/services/restart-news/previous-run-death.ts";
import { initialStartReason } from "../../../src/services/restart-news/supervisor-start-reason.ts";
import type { MemoryPulse } from "../../../src/services/memory-pulse.ts";

const T = Date.parse("2026-11-20T12:36:57Z");
// The dead server's last two readings on 20/11/2026.
const pulse: MemoryPulse = {
  pid: 14020,
  samples: [
    { t: T - 30_000, commit: { freeMB: 9000, limitMB: 62_300 }, branches: [{ pid: 45716, name: "claude", session: "20decca7", treeMB: 1256 }] },
    { t: T, commit: { freeMB: 6000, limitMB: 62_300 }, branches: [{ pid: 45716, name: "claude", session: "20decca7", treeMB: 3714 }] },
  ],
};
const dead = (over: Partial<PreviousRunFacts> = {}): PreviousRunFacts => ({
  prevStatus: { supervisorPid: 45584, pid: 14020, state: "running" },
  supervisorAlive: false,
  pulse,
  oomEvents: [],
  ...over,
});

describe("diagnosePreviousRunDeath", () => {
  it("calls an OS low-memory report near the last reading out of memory, naming the fastest grower", () => {
    const r = diagnosePreviousRunDeath(dead({ oomEvents: [{ t: Date.parse("2026-11-20T12:37:20Z"), source: "Windows" }] }));
    expect(r).toEqual({
      kind: "oom",
      detail: "Windows reported low memory at 12:37:20Z; chat session 20decca7 grew from 1256 MB to 3714 MB in 30 s before it; free commit 5.9 of 60.8 GB at the last reading",
    });
  });

  it("takes nearly exhausted free commit at the last reading as evidence on its own", () => {
    const low: MemoryPulse = { ...pulse, samples: [pulse.samples[0]!, { ...pulse.samples[1]!, commit: { freeMB: 1500, limitMB: 62_300 } }] };
    expect(diagnosePreviousRunDeath(dead({ pulse: low }))).toMatchObject({ kind: "oom", detail: expect.stringContaining("free commit was 1.5 of 60.8 GB") });
  });

  it("says crash, with what is known, when there is no memory evidence", () => {
    expect(diagnosePreviousRunDeath(dead())).toEqual({
      kind: "crash",
      detail: "the previous supervisor (pid 45584) was gone without stopping; last memory reading at 12:36:57Z; free commit 5.9 of 60.8 GB",
    });
    expect(diagnosePreviousRunDeath(dead({ pulse: null }))?.detail).toBe("the previous supervisor (pid 45584) was gone without stopping");
  });

  it("finds no death when the supervisor lives, PPM was stopped, there is no status, or the run ended with the machine", () => {
    expect(diagnosePreviousRunDeath(dead({ supervisorAlive: true }))).toBeNull();
    expect(diagnosePreviousRunDeath(dead({ prevStatus: { supervisorPid: 1, state: "stopped" } }))).toBeNull();
    expect(diagnosePreviousRunDeath(dead({ prevStatus: {} }))).toBeNull();
    expect(diagnosePreviousRunDeath(dead({ bootAt: T + 60_000 }))).toBeNull();
    expect(diagnosePreviousRunDeath(dead({ pulse: null, statusWrittenAt: T, bootAt: T + 1 }))).toBeNull();
    expect(diagnosePreviousRunDeath(dead({ bootAt: T - 60_000 }))?.kind).toBe("crash");
  });
});

describe("oomEventWindow", () => {
  it("looks around the last reading, else at the last hour", () => {
    expect(oomEventWindow(pulse, T + 3_600_000)).toEqual({ from: T - OOM_EVENT_BEFORE_MS, to: T + OOM_EVENT_AFTER_MS });
    expect(oomEventWindow(pulse, T + 1000)).toEqual({ from: T - OOM_EVENT_BEFORE_MS, to: T + 1000 });
    expect(oomEventWindow(null, T)).toEqual({ from: T - 3_600_000, to: T });
  });
});

describe("OS report parsers", () => {
  it("reads event times from wevtutil XML", () => {
    const xml = `<Event><System><TimeCreated SystemTime='2026-11-20T12:37:20.1234567Z'/></System></Event>`
      + `<Event><System><TimeCreated SystemTime="2026-11-20T12:37:21.000Z"/></System></Event>`;
    expect(parseWevtutilTimes(xml)).toEqual([Date.parse("2026-11-20T12:37:20.123Z"), Date.parse("2026-11-20T12:37:21Z")]);
    expect(parseWevtutilTimes("")).toEqual([]);
  });

  it("reads line times from journalctl short-unix output", () => {
    expect(parseJournalUnixTimes("1763642240.123456 host kernel: Out of memory: Killed process 12\nnoise\n")).toEqual([1763642240123]);
  });
});

describe("initialStartReason with a previous death", () => {
  it("puts the death first and keeps who brought PPM back", () => {
    const death = { kind: "oom" as const, detail: "Windows reported low memory" };
    expect(initialStartReason({ isUpgrade: false, uptimeS: 99_999, takeRequest: () => ({ kind: "manual", requestedBy: "ppm restart pid 54012" }), previousDeath: death }))
      .toEqual({ ...death, requestedBy: "ppm restart pid 54012" });
    expect(initialStartReason({ isUpgrade: false, uptimeS: 60, takeRequest: () => null, previousDeath: death })).toEqual(death);
    expect(initialStartReason({ isUpgrade: true, uptimeS: 60, takeRequest: () => null, previousDeath: death })).toEqual({ kind: "upgrade" });
    expect(initialStartReason({ isUpgrade: false, uptimeS: 99_999, takeRequest: () => null, previousDeath: null }).kind).toBe("manual");
  });
});
