/**
 * `settings:changed {section}` on `/ws/global`: a settings section changed on the server — from a
 * screen, the `ppm` CLI or another device — so every open PPM reads that section again (and the
 * theme is re-applied) instead of showing the change only after a reload.
 *
 * Only the sections listed here are ever announced. UI preferences (`PUT /ui-prefs`, written on
 * every sidebar drag) and provider probes are not settings changes and announce nothing.
 */
export const SETTINGS_CHANGED_EVENT = "settings:changed";

export const SETTINGS_EVENT_SECTIONS = [
  "theme", "themes", "ai", "keybindings", "proxy", "query-audit", "session-trace", "files",
  // Notifications (what and when, ntfy, push devices), the notification bot and its chats,
  // the Assistant's Telegram bot (`clawbot`), MCP servers, and the Claude and Codex accounts.
  "notifications", "telegram", "clawbot", "mcp", "accounts",
] as const;

export type SettingsSection = typeof SETTINGS_EVENT_SECTIONS[number];

export interface SettingsChangedEvent {
  type: typeof SETTINGS_CHANGED_EVENT;
  section: SettingsSection;
}

export function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === "string" && (SETTINGS_EVENT_SECTIONS as readonly string[]).includes(value);
}
