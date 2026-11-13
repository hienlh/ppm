import { describe, it, expect } from "bun:test";
import { createTimeZoneReporter, deviceTimeZone } from "../../../src/web/lib/client-timezone-reporter";

function harness(initialZone: string | null) {
  let zone = initialZone;
  let resume: (() => void) | null = null;
  const sent: unknown[] = [];
  const reporter = createTimeZoneReporter((json) => sent.push(JSON.parse(json)), {
    zone: () => zone,
    deviceId: () => "device-1234",
    onResume: (listener) => { resume = listener; return () => { resume = null; }; },
  });
  return {
    reporter, sent,
    setZone(next: string | null) { zone = next; },
    resume() { resume?.(); },
    get watching() { return resume !== null; },
  };
}

describe("createTimeZoneReporter", () => {
  it("reports the zone each time the socket connects", () => {
    const h = harness("Europe/London");
    h.reporter.onConnectionChange(true);
    h.reporter.onConnectionChange(false);
    h.reporter.onConnectionChange(true);
    expect(h.sent).toEqual([
      { type: "client:timezone", timeZone: "Europe/London", deviceId: "device-1234" },
      { type: "client:timezone", timeZone: "Europe/London", deviceId: "device-1234" },
    ]);
  });

  it("reports again on resume only when the zone changed, and never while disconnected", () => {
    const h = harness("Europe/London");
    h.reporter.onConnectionChange(true);
    h.resume();
    expect(h.sent).toHaveLength(1);
    h.setZone("Asia/Saigon");
    h.resume();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toEqual({ type: "client:timezone", timeZone: "Asia/Saigon", deviceId: "device-1234" });
    h.reporter.onConnectionChange(false);
    h.setZone("America/New_York");
    h.resume();
    expect(h.sent).toHaveLength(2);
  });

  it("sends nothing when the browser cannot say its zone, and stops watching on dispose", () => {
    const h = harness(null);
    h.reporter.onConnectionChange(true);
    expect(h.sent).toEqual([]);
    h.reporter.dispose();
    expect(h.watching).toBe(false);
  });
});

describe("deviceTimeZone", () => {
  it("answers the IANA name Intl resolves", () => {
    expect(deviceTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});
