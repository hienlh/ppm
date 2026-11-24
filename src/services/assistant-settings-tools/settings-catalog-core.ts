import { configService } from "../config.service.ts";
import { readVoiceSettings } from "../voice-message/voice-settings.ts";
import { VOICE_SURFACES } from "../../shared/voice-message.ts";
import { LOG_LEVELS } from "../../shared/log-levels.ts";
import { MAX_LEFTOVER_IDLE_MINUTES } from "../../shared/leftover-processes.ts";
import {
  MAX_NOTIFICATION_DELAY_SECONDS, NOTIFICATION_EVENT_COPY, NOTIFICATION_EVENTS, resolveNotificationSettings,
} from "../../shared/notification-settings.ts";
import { SESSION_TRACE_MIN_RETENTION_DAYS, SESSION_TRACE_MIN_SIZE_MB } from "../../shared/storage-settings.ts";
import type { SettingEntry } from "./settings-catalog-types.ts";

/**
 * General, Appearance, Voice Input, Notifications, Storage and File Filters. Every write here is the
 * Settings pane's own route; reads are the getters those routes use.
 */

const BOOL = { type: "boolean" } as const;
/** Lowering a retention limit deletes older traces or query logs at once, and Undo cannot bring them back. */
const PRUNES = "It can delete older history for good";
/** A lower limit than before (the same number back again is not lower). */
const lowered = (before: unknown, after: unknown) => typeof before === "number" && typeof after === "number" && after < before;
const lowerWarns = () => "A lower limit deletes what is older or larger right away; Undo puts the number back, not what was deleted.";
const notifications = () => resolveNotificationSettings(configService.get("notifications"));
const configKey = (key: string) => (value: unknown) => ({ method: "PUT" as const, path: "/api/settings/config-key", body: { key, value } });
const anyConfig = () => configService.getAll() as unknown as Record<string, unknown>;

const THEME_STYLE_LABELS = { aurora: "Aurora", slate: "Slate", precision: "Precision" } as const;
const THEME_MODE_LABELS = { light: "Light", dark: "Dark", system: "Follow the system" } as const;
const theme = () => configService.get("theme") ?? { style: "aurora", mode: "system" as const };

export const CORE_SETTINGS: readonly SettingEntry[] = [
  {
    key: "device_name", category: "general", label: "General → Device name", tier: "direct",
    value: { type: "text", maxLength: 100 },
    read: () => configService.get("device_name") ?? "",
    write: (value) => ({ method: "PUT", path: "/api/settings/device-name", body: { device_name: value } }),
  },
  {
    key: "log_level", category: "general", label: "General → Log level", tier: "direct",
    value: { type: "enum", values: LOG_LEVELS },
    read: () => (typeof anyConfig().log_level === "string" ? anyConfig().log_level : "info"),
    write: configKey("log_level"),
  },
  {
    key: "auth.enabled", category: "general", label: "General → Require login", tier: "card",
    cardReason: "It changes who can reach PPM",
    value: BOOL,
    read: () => configService.get("auth").enabled,
    write: configKey("auth.enabled"),
    warn: (value) => (value === false ? "Anyone who can reach this PPM's address can use it, with no password." : null),
  },
  {
    key: "theme.style", category: "appearance", label: "Appearance → Theme", tier: "direct",
    value: { type: "enum", values: Object.keys(THEME_STYLE_LABELS), labels: THEME_STYLE_LABELS },
    read: () => theme().style,
    write: (value) => ({ method: "PUT", path: "/api/settings/theme", body: { style: value, mode: theme().mode } }),
    note: "Choosing a built-in theme leaves an imported custom theme; the user picks that again in Settings → Appearance.",
  },
  {
    key: "theme.mode", category: "appearance", label: "Appearance → Light or dark", tier: "direct",
    value: { type: "enum", values: Object.keys(THEME_MODE_LABELS), labels: THEME_MODE_LABELS },
    read: () => theme().mode,
    write: (value) => {
      const t = theme();
      return { method: "PUT", path: "/api/settings/theme", body: { style: t.style, mode: value, ...(t.customThemeId ? { customThemeId: t.customThemeId } : {}) } };
    },
  },
  {
    key: "voice.enabled", category: "voice", label: "Voice Input → Voice messages", tier: "direct",
    value: BOOL,
    read: () => readVoiceSettings().enabled === true,
    write: (value) => ({ method: "PUT", path: "/api/speech/voice-settings", body: { enabled: value } }),
  },
  {
    key: "voice.review_before_send", category: "voice", label: "Voice Input → Read the transcript before sending", tier: "direct",
    value: BOOL,
    read: () => readVoiceSettings().review_before_send,
    write: (value) => ({ method: "PUT", path: "/api/speech/voice-settings", body: { reviewBeforeSend: value } }),
  },
  // Kept for older undo rows and for "turn the clean-up off" asked of the Assistant: on means both
  // surfaces tidy with Haiku, off means both send Whisper's text with hints. A change is made as
  // one change per surface, so undoing it gives each surface back its own old choice.
  {
    key: "voice.cleanup_enabled", category: "voice", label: "Voice Input → Haiku clean-up (chat box and Telegram)", tier: "direct",
    value: BOOL,
    read: () => VOICE_SURFACES.every((s) => readVoiceSettings().transcript_fix[s] === "haiku"),
    write: (value) => ({ method: "PUT", path: "/api/speech/voice-settings", body: { cleanupEnabled: value } }),
    expand: (value) => VOICE_SURFACES.map((surface) => ({ key: `voice.transcript_fix.${surface}`, value: value ? "haiku" : "hints" })),
  },
  ...VOICE_SURFACES.map((surface): SettingEntry => ({
    key: `voice.transcript_fix.${surface}`, category: "voice",
    label: `Voice Input → ${surface === "composer" ? "Chat box" : "Telegram"} transcript: Haiku clean-up or hints`, tier: "direct",
    value: { type: "enum", values: ["haiku", "hints"], labels: { haiku: "Tidied by Claude Haiku", hints: "As heard, with hints" } },
    read: () => readVoiceSettings().transcript_fix[surface],
    write: (value) => ({ method: "PUT", path: "/api/speech/voice-settings", body: { transcriptFix: { [surface]: value } } }),
  })),
  {
    key: "voice.words", category: "voice", label: "Voice Input → Words for every project", tier: "direct",
    value: { type: "string_list", maxItems: 200, maxLength: 80 },
    read: () => readVoiceSettings().words,
    write: (value) => ({ method: "PUT", path: "/api/speech/voice-settings", body: { words: value } }),
  },
  ...NOTIFICATION_EVENTS.map((event): SettingEntry => ({
    key: `notifications.events.${event}`, category: "notifications",
    label: `Notifications → ${NOTIFICATION_EVENT_COPY[event].label}`, tier: "direct",
    // Switching approval alerts off would let a card wait unseen: that direction asks.
    ...(event === "approval_request"
      ? { cardReason: "It silences the alert that a card is waiting for you", cardWhen: (_b: unknown, after: unknown) => after === false, cardWhenText: "when it is switched off" }
      : {}),
    value: BOOL,
    read: () => notifications().events[event],
    write: (value) => ({ method: "PUT", path: "/api/notifications/settings", body: { events: { [event]: value } } }),
  })),
  {
    key: "notifications.delay_seconds", category: "notifications", label: "Notifications → Wait before notifying", tier: "direct",
    value: { type: "int", min: 0, max: MAX_NOTIFICATION_DELAY_SECONDS, unit: "seconds" },
    read: () => notifications().delay_seconds,
    write: (value) => ({ method: "PUT", path: "/api/notifications/settings", body: { delay_seconds: value } }),
  },
  {
    key: "notifications.telegram", category: "notifications", label: "Notifications → Send to Telegram", tier: "direct",
    value: BOOL,
    read: () => notifications().telegram,
    write: (value) => ({ method: "PUT", path: "/api/notifications/settings", body: { telegram: value } }),
  },
  {
    key: "notifications.ntfy", category: "notifications", label: "Notifications → Send to ntfy", tier: "direct",
    value: BOOL,
    read: () => notifications().ntfy,
    write: (value) => ({ method: "PUT", path: "/api/notifications/settings", body: { ntfy: value } }),
  },
  {
    key: "ai.leftover_processes_idle_minutes", category: "ai-provider",
    label: "AI Provider → Stop processes a chat left running after (0 = never)", tier: "direct",
    value: { type: "int", min: 0, max: MAX_LEFTOVER_IDLE_MINUTES, unit: "minutes" },
    read: () => configService.get("ai").leftover_processes_idle_minutes ?? 0,
    write: (value) => ({ method: "PUT", path: "/api/settings/ai", body: { leftover_processes_idle_minutes: value } }),
  },
  {
    key: "session_trace.retention_days", category: "storage", label: "Storage → Keep session traces for", tier: "direct", cardReason: PRUNES, cardWhen: lowered, cardWhenText: "when the limit is lowered", warn: lowerWarns,
    value: { type: "int", min: SESSION_TRACE_MIN_RETENTION_DAYS, max: 3650, unit: "days" },
    read: () => configService.get("session_trace")?.retention_days ?? null,
    write: (value) => ({ method: "PUT", path: "/api/settings/session-trace", body: { retention_days: value } }),
  },
  {
    key: "session_trace.max_size_mb", category: "storage", label: "Storage → Session traces at most", tier: "direct", cardReason: PRUNES, cardWhen: lowered, cardWhenText: "when the limit is lowered", warn: lowerWarns,
    value: { type: "int", min: SESSION_TRACE_MIN_SIZE_MB, max: 102_400, unit: "MB" },
    read: () => configService.get("session_trace")?.max_size_mb ?? null,
    write: (value) => ({ method: "PUT", path: "/api/settings/session-trace", body: { max_size_mb: value } }),
  },
  {
    key: "query_audit.retention_days", category: "storage", label: "Storage → Keep the query log for", tier: "direct", cardReason: PRUNES, cardWhen: lowered, cardWhenText: "when the limit is lowered", warn: lowerWarns,
    value: { type: "int", min: 1, max: 3650, unit: "days" },
    read: () => configService.get("query_audit")?.retention_days ?? null,
    write: (value) => ({ method: "PUT", path: "/api/settings/query-audit", body: { retention_days: value } }),
  },
  {
    key: "query_audit.max_size_mb", category: "storage", label: "Storage → Query log at most", tier: "direct", cardReason: PRUNES, cardWhen: lowered, cardWhenText: "when the limit is lowered", warn: lowerWarns,
    value: { type: "int", min: 10, max: 102_400, unit: "MB" },
    read: () => configService.get("query_audit")?.max_size_mb ?? null,
    write: (value) => ({ method: "PUT", path: "/api/settings/query-audit", body: { max_size_mb: value } }),
  },
  {
    key: "files.exclude", category: "files", label: "File Filters → Hidden from the file tree", tier: "direct",
    value: { type: "string_list", maxItems: 200, maxLength: 200 },
    read: () => configService.getFilesExclude(),
    write: (value) => ({ method: "PATCH", path: "/api/settings/files", body: { filesExclude: value } }),
  },
  {
    key: "files.search_exclude", category: "files", label: "File Filters → Left out of search", tier: "direct",
    value: { type: "string_list", maxItems: 200, maxLength: 200 },
    read: () => configService.getSearchExclude(),
    write: (value) => ({ method: "PATCH", path: "/api/settings/files", body: { searchExclude: value } }),
  },
  {
    key: "files.use_ignore_files", category: "files", label: "File Filters → Follow .gitignore", tier: "direct",
    value: BOOL,
    read: () => configService.getUseIgnoreFiles(),
    write: (value) => ({ method: "PATCH", path: "/api/settings/files", body: { useIgnoreFiles: value } }),
  },
];
