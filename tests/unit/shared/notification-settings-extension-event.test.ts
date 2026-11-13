import { describe, expect, it } from "bun:test";
import {
  applyNotificationSettingsPatch,
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_EVENT_COPY,
  NOTIFICATION_EVENTS,
  parseNotificationSettingsPatch,
  resolveNotificationSettings,
} from "../../../src/shared/notification-settings.ts";

describe("the extension notification event", () => {
  it("is in the event list, with its own copy", () => {
    expect(NOTIFICATION_EVENTS).toContain("extension");
    expect(NOTIFICATION_EVENT_COPY.extension).toEqual({ label: "Extensions", note: "An extension asked to tell you something." });
  });

  it("is on by default, and can be switched off", () => {
    expect(DEFAULT_NOTIFICATION_SETTINGS.events.extension).toBe(true);
    const parsed = parseNotificationSettingsPatch({ events: { extension: false } });
    expect(parsed).toEqual({ ok: true, patch: { events: { extension: false } } });
    if (parsed.ok) expect(applyNotificationSettingsPatch(DEFAULT_NOTIFICATION_SETTINGS, parsed.patch).events.extension).toBe(false);
  });

  it("is switched on for a settings row saved before the event existed", () => {
    expect(resolveNotificationSettings({ events: { done: false } }).events.extension).toBe(true);
    expect(resolveNotificationSettings({ events: { done: false } }).events.done).toBe(false);
  });
});
