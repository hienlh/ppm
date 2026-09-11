/**
 * The event-loop lag monitor.
 *
 * The number that matters here is not the lag, it is the CPU measured across
 * the same gap: a 9-second stall the process spent *running* is our own
 * synchronous work and worth hunting in this repository, while a 9-second stall
 * the process spent descheduled is the machine being oversubscribed and cannot
 * be fixed by any change to PPM — moving the work to a worker thread least of
 * all, since there was no CPU to move it onto. The two look identical from
 * outside, which is why `/api/health` taking 18.9s told us nothing about where
 * to look.
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  classifyLag,
  sampleFromTick,
  startLagMonitor,
  stopLagMonitor,
  lagReport,
  resetLagMonitorForTest,
  TICK_MS,
  REPORT_THRESHOLD_MS,
  MAX_SAMPLES,
} from "../../../src/services/event-loop-lag.ts";

afterEach(() => {
  stopLagMonitor();
  resetLagMonitorForTest();
});

describe("telling our own stall from someone else's", () => {
  it("calls a gap we spent running our own", () => {
    // 5s late, 4.8s of CPU burned: the loop was busy with our work or with GC.
    expect(classifyLag(5000, 4800)).toBe("self");
  });

  it("calls a gap we spent off the CPU starvation", () => {
    // 5s late, 40ms of CPU: the process was not scheduled. Nothing in PPM's
    // code did this, so no amount of restructuring PPM's code fixes it.
    expect(classifyLag(5000, 40)).toBe("starved");
  });

  it("does not force a verdict on a gap that was half and half", () => {
    expect(classifyLag(1000, 450)).toBe("mixed");
  });

  it("still reads more CPU than wall time as our own", () => {
    // `cpuUsage` counts every thread and Bun runs fs work on a pool, so a gap
    // spent in parallel IO bills more CPU than wall time passed. That is still
    // our work — the ratio going over 1 must not fall through to "mixed".
    expect(classifyLag(1000, 2600)).toBe("self");
  });
});

describe("turning one tick into a sample", () => {
  const base = { now: 1_700_000_000_000, cpuMicros: 0, rssBytes: 700 * 1048576 };

  it("says nothing about a tick that arrived on time", () => {
    expect(sampleFromTick({ ...base, elapsedMs: TICK_MS + 5 })).toBeNull();
  });

  it("reports the slip, not the whole gap", () => {
    // A tick 250ms late took TICK_MS + 250 to arrive; the interval itself is
    // not lag, and counting it would report a stall on every healthy tick.
    const s = sampleFromTick({ ...base, elapsedMs: TICK_MS + 600, cpuMicros: 580_000 });
    expect(s).not.toBeNull();
    expect(s!.lagMs).toBe(600);
    expect(s!.cpuMs).toBe(580);
    expect(s!.cause).toBe("self");
  });

  it("fires exactly at the threshold, not one tick past it", () => {
    expect(sampleFromTick({ ...base, elapsedMs: TICK_MS + REPORT_THRESHOLD_MS })).not.toBeNull();
    expect(sampleFromTick({ ...base, elapsedMs: TICK_MS + REPORT_THRESHOLD_MS - 1 })).toBeNull();
  });

  it("carries the resident set, so a stall that is really GC pressure shows it", () => {
    const s = sampleFromTick({ ...base, elapsedMs: TICK_MS + 400, rssBytes: 1536 * 1048576 });
    expect(s!.rssMb).toBe(1536);
  });
});

describe("the monitor itself", () => {
  it("starts, reports, and stops", async () => {
    startLagMonitor();
    expect(lagReport().running).toBe(true);
    await Bun.sleep(TICK_MS * 3);
    const r = lagReport();
    expect(r.ticks).toBeGreaterThan(0);
    stopLagMonitor();
    expect(lagReport().running).toBe(false);
  });

  it("does not start a second timer when started twice", async () => {
    startLagMonitor();
    startLagMonitor();
    await Bun.sleep(TICK_MS * 4);
    const { ticks } = lagReport();
    // Two timers would roughly double the count for the same wall time.
    expect(ticks).toBeLessThanOrEqual(6);
  });

  it("sees a stall it caused itself, and bills it to us", async () => {
    startLagMonitor();
    await Bun.sleep(TICK_MS);
    // Block the loop the way a synchronous read or a big parse would.
    const until = Date.now() + 700;
    while (Date.now() < until) { /* spin */ }
    await Bun.sleep(TICK_MS * 2);

    const r = lagReport();
    expect(r.stalls).toBeGreaterThan(0);
    expect(r.worstMs).toBeGreaterThanOrEqual(400);
    expect(r.samples.at(-1)!.cause).toBe("self"); // we burned the CPU, and it says so
    expect(r.blockedFraction).toBeGreaterThan(0);
  });

  it("keeps the buffer bounded so a bad hour cannot grow without limit", () => {
    // A diagnostic that leaks memory on the server it is diagnosing is worse
    // than none. Asserted on the constant rather than by generating 240 stalls.
    expect(MAX_SAMPLES).toBeLessThanOrEqual(500);
  });

  it("reports nothing rather than dividing by zero before it has run", () => {
    const r = lagReport();
    expect(r.running).toBe(false);
    expect(r.blockedFraction).toBe(0);
    expect(r.samples).toEqual([]);
  });
});
