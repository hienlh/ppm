import { describe, expect, it } from "bun:test";
import {
  RESCUE_NOTICE_MAX_AGE_MS, rescueNoticeFrom,
} from "../../../../src/services/remote-desktop/win32-helper/rescue-notice.ts";

const AT = "2026-11-27T08:00:00.000Z";
const NOW = Date.parse(AT) + 60_000;
/** The messages are the helper's own (`rescue-script.ts`, `Invoke-Rescue` + `Set-ConsoleScreen`). */
const ran = (what: string) => ({
  action: "Rescue", ok: true, at: AT, message: `Safety net ran: Reattach was not confirmed in time. ${what}`,
});

describe("rescueNoticeFrom", () => {
  it("speaks up when the net turned the virtual display on", () => {
    expect(rescueNoticeFrom(ran("Turned the virtual display on for the session at this PC."), NOW))
      .toEqual({ at: AT, outcome: "display-on" });
  });

  it("speaks up when there was no driver to turn on", () => {
    expect(rescueNoticeFrom(ran("No virtual display driver to turn on."), NOW)).toEqual({ at: AT, outcome: "no-driver" });
  });

  it("stays quiet when the net ran and nothing needed doing", () => {
    expect(rescueNoticeFrom(ran("The session at this PC has a screen."), NOW)).toBeNull();
  });

  it("stays quiet for a run where the net did nothing, or any other action", () => {
    expect(rescueNoticeFrom({ action: "Rescue", ok: true, at: AT, message: "Nothing was waiting: the last change was confirmed." }, NOW)).toBeNull();
    expect(rescueNoticeFrom({ action: "Rescue", ok: true, at: AT, message: "Not due yet." }, NOW)).toBeNull();
    expect(rescueNoticeFrom({ ...ran("Turned the virtual display on for the session at this PC."), action: "Confirm" }, NOW)).toBeNull();
    expect(rescueNoticeFrom({ ...ran("Turned the virtual display on for the session at this PC."), ok: false }, NOW)).toBeNull();
  });

  it("forgets a run older than a day, and anything it cannot read", () => {
    expect(rescueNoticeFrom(ran("Turned the virtual display on for the session at this PC."), Date.parse(AT) + RESCUE_NOTICE_MAX_AGE_MS + 1)).toBeNull();
    expect(rescueNoticeFrom(null, NOW)).toBeNull();
    expect(rescueNoticeFrom({ action: "Rescue", ok: true, at: "soon", message: "Safety net ran: Turned the virtual display on" }, NOW)).toBeNull();
  });
});
