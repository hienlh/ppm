import { describe, it, expect, beforeEach } from "bun:test";
import {
  isValidTimeZone, lastClientTimeZone, recordClientTimeZone, resetClientTimeZone,
} from "../../../src/services/client-timezone.ts";
import { extensionWebSocket } from "../../../src/server/ws/extensions.ts";

const DEVICE = "0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b";

beforeEach(resetClientTimeZone);

describe("isValidTimeZone", () => {
  it("accepts zones Intl knows and refuses anything else", () => {
    for (const zone of ["Europe/London", "Asia/Saigon", "Asia/Ho_Chi_Minh", "UTC", "America/Argentina/Buenos_Aires"]) {
      expect(isValidTimeZone(zone)).toBe(true);
    }
    for (const zone of ["", "Mars/Olympus", "Europe/London; DROP", 7, null, undefined, "x".repeat(65)]) {
      expect(isValidTimeZone(zone)).toBe(false);
    }
  });
});

describe("recordClientTimeZone", () => {
  it("keeps the latest valid report with the time it arrived", () => {
    expect(lastClientTimeZone()).toBeNull();
    expect(recordClientTimeZone("Europe/London", DEVICE, 1000)).toEqual({ timeZone: "Europe/London", deviceId: DEVICE, at: 1000 });
    recordClientTimeZone("Asia/Saigon", DEVICE, 2000);
    expect(lastClientTimeZone()).toEqual({ timeZone: "Asia/Saigon", deviceId: DEVICE, at: 2000 });
  });

  it("drops an unknown zone or a malformed device id, keeping the previous report", () => {
    recordClientTimeZone("Europe/London", DEVICE, 1000);
    expect(recordClientTimeZone("Not/AZone", DEVICE)).toBeNull();
    expect(recordClientTimeZone("Asia/Saigon", "short")).toBeNull();
    expect(recordClientTimeZone("Asia/Saigon", "has spaces in it!")).toBeNull();
    expect(lastClientTimeZone()?.timeZone).toBe("Europe/London");
  });
});

describe("/ws/extensions client:timezone", () => {
  const ws = { data: { type: "extensions" }, send: () => {} };

  it("records a valid report and ignores an invalid one", async () => {
    await extensionWebSocket.message(ws, JSON.stringify({ type: "client:timezone", timeZone: "Europe/London", deviceId: DEVICE }));
    expect(lastClientTimeZone()?.timeZone).toBe("Europe/London");
    await extensionWebSocket.message(ws, JSON.stringify({ type: "client:timezone", timeZone: "Nowhere/Land", deviceId: DEVICE }));
    expect(lastClientTimeZone()?.timeZone).toBe("Europe/London");
  });
});
