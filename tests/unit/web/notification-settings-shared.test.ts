import { describe, expect, it } from "bun:test";
import {
  applyNotificationSettingsPatch,
  DEFAULT_NOTIFICATION_SETTINGS,
  normalizeNtfyServer,
  NOTIFICATION_DELAY_OPTIONS,
  NOTIFICATION_EVENT_COPY,
  NOTIFICATION_EVENTS,
  NTFY_TOPIC_RE,
  parseNotificationSettingsPatch,
  resolveNotificationSettings,
} from "../../../src/shared/notification-settings.ts";

describe("resolveNotificationSettings", () => {
  it("gives the defaults to an install that has never saved any", () => {
    expect(resolveNotificationSettings(undefined)).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    expect(resolveNotificationSettings("garbage")).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  });

  it("keeps what is valid and repairs the rest, field by field", () => {
    expect(resolveNotificationSettings({ events: { done: false, jira: "no", extra: true }, delay_seconds: 99999, telegram: false, ntfy: "no" })).toEqual({
      events: { ...DEFAULT_NOTIFICATION_SETTINGS.events, done: false },
      delay_seconds: DEFAULT_NOTIFICATION_SETTINGS.delay_seconds,
      telegram: false,
      ntfy: true,
    });
  });

  it("does not hand out the shared default object", () => {
    const a = resolveNotificationSettings(undefined);
    a.events.done = false;
    expect(DEFAULT_NOTIFICATION_SETTINGS.events.done).toBe(true);
  });

  it("offers the default delay and has copy for every event", () => {
    expect(NOTIFICATION_DELAY_OPTIONS.map((o) => o.seconds)).toContain(DEFAULT_NOTIFICATION_SETTINGS.delay_seconds);
    expect(Object.keys(NOTIFICATION_EVENT_COPY).sort()).toEqual([...NOTIFICATION_EVENTS].sort());
  });
});

describe("the ntfy switch", () => {
  it("is on by default, so a server once set up is used, and can be paused", () => {
    expect(DEFAULT_NOTIFICATION_SETTINGS.ntfy).toBe(true);
    const parsed = parseNotificationSettingsPatch({ ntfy: false });
    expect(parsed).toEqual({ ok: true, patch: { ntfy: false } });
    if (parsed.ok) expect(applyNotificationSettingsPatch(DEFAULT_NOTIFICATION_SETTINGS, parsed.patch).ntfy).toBe(false);
    expect(parseNotificationSettingsPatch({ ntfy: "off" })).toEqual({ ok: false, error: "ntfy must be true or false" });
  });
});

describe("normalizeNtfyServer", () => {
  it("takes an address as people type it and keeps only the server's base URL", () => {
    expect(normalizeNtfyServer("ntfy.thawngho.com")).toBe("https://ntfy.thawngho.com");
    expect(normalizeNtfyServer("  https://ntfy.sh/  ")).toBe("https://ntfy.sh");
    expect(normalizeNtfyServer("https://ntfy.sh/?a=1#b")).toBe("https://ntfy.sh");
    expect(normalizeNtfyServer("http://192.168.1.5:8090")).toBe("http://192.168.1.5:8090");
    expect(normalizeNtfyServer("https://example.com/ntfy/")).toBe("https://example.com/ntfy");
  });

  it("refuses what is not a web address, and an address carrying a password", () => {
    for (const typed of ["", "   ", "ftp://ntfy.sh", "javascript:alert(1)", "https://user:pass@ntfy.sh", "https://"]) {
      expect(normalizeNtfyServer(typed)).toBeNull();
    }
  });
});

describe("NTFY_TOPIC_RE", () => {
  it("is ntfy's own rule: 1 to 64 letters, digits, - or _", () => {
    for (const topic of ["ppm", "ppm-alerts_2", "a".repeat(64)]) expect(NTFY_TOPIC_RE.test(topic)).toBe(true);
    for (const topic of ["", "a".repeat(65), "ppm alerts", "ppm/alerts", "thông-báo"]) expect(NTFY_TOPIC_RE.test(topic)).toBe(false);
  });
});
