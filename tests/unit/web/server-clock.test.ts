import { afterEach, describe, expect, test } from "bun:test";
import { noteServerTime, resetServerClock, serverClockOffset, serverNow } from "../../../src/web/lib/server-clock";

afterEach(() => resetServerClock());

describe("server clock", () => {
  test("uses the browser's clock until the server has said what time it is", () => {
    expect(serverClockOffset()).toBe(0);
    expect(Math.abs(serverNow() - Date.now())).toBeLessThanOrEqual(5);
  });

  test("takes the smallest sample: the clock difference plus the least latency seen", () => {
    noteServerTime(1_000_000, 1_015_080); // a browser 15 s fast, 80 ms in flight
    noteServerTime(2_000_000, 2_015_020); // 20 ms in flight
    noteServerTime(3_000_000, 3_015_300);
    expect(serverClockOffset()).toBe(15_020);
  });

  test("a clock that was set since starts over instead of keeping the old difference", () => {
    noteServerTime(1_000_000, 1_090_000); // 90 s fast
    noteServerTime(2_000_000, 2_000_040); // then corrected
    expect(serverClockOffset()).toBe(40);
  });

  test("ignores what is not a time", () => {
    noteServerTime(undefined);
    noteServerTime("12");
    noteServerTime(Number.NaN);
    expect(serverClockOffset()).toBe(0);
  });
});
