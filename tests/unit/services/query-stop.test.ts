/**
 * Stopping a running statement: armed once on a time limit or an abort, whichever comes first,
 * remembering which it was, and disarmed when the run ends.
 */
import { describe, expect, it } from "bun:test";
import { armQueryStop, QueryStoppedError, throwIfAborted } from "../../../src/services/database/query-stop.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("armQueryStop", () => {
  it("stops once, on the time limit, and says so", async () => {
    let stops = 0;
    const stop = armQueryStop({ timeoutMs: 20 }, () => { stops++; });
    expect(stop.reason()).toBeNull();
    await wait(60);
    expect(stops).toBe(1);
    expect(stop.reason()).toBe("timeout");
    expect(() => stop.throwIfStopped()).toThrow("longer than 20 ms");
    stop.dispose();
  });

  it("stops on an abort before the limit, and only once", async () => {
    let stops = 0;
    const controller = new AbortController();
    const stop = armQueryStop({ timeoutMs: 40, signal: controller.signal }, () => { stops++; });
    controller.abort();
    await wait(80);
    expect(stops).toBe(1);
    expect(stop.reason()).toBe("aborted");
    stop.dispose();
  });

  it("does nothing once disarmed, and survives a stop that throws", async () => {
    const controller = new AbortController();
    let stops = 0;
    const stop = armQueryStop({ timeoutMs: 20, signal: controller.signal }, () => { stops++; });
    stop.dispose();
    controller.abort();
    await wait(50);
    expect(stops).toBe(0);
    const throwing = armQueryStop({ timeoutMs: 5 }, () => { throw new Error("already ended"); });
    await wait(30);
    expect(throwing.reason()).toBe("timeout");
  });

  it("refuses to start for a caller that has already gone", () => {
    const controller = new AbortController();
    expect(() => throwIfAborted({ signal: controller.signal })).not.toThrow();
    controller.abort();
    expect(() => throwIfAborted({ signal: controller.signal })).toThrow(QueryStoppedError);
    expect(new QueryStoppedError("timeout", 60_000).message).toContain("60 s");
  });
});
