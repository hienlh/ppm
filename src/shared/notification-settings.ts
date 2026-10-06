/**
 * Notification settings shared by the server (which decides what to send) and the
 * Settings pane (which edits them).
 *
 * Push is not switched here: a browser either holds a push subscription or it does
 * not, so "push on this device" is the subscription itself. Telegram and ntfy have a
 * switch each, so a channel that is set up — a bot and its chats, a server and its
 * topic — can be paused without being forgotten.
 */

export type NotificationEvent = "done" | "approval_request" | "question" | "schedule" | "jira";

export const NOTIFICATION_EVENTS: readonly NotificationEvent[] = [
  "done", "approval_request", "question", "schedule", "jira",
];

export interface NotificationSettings {
  events: Record<NotificationEvent, boolean>;
  /**
   * How long to wait before sending. 0 sends at once. Anything else sends only if,
   * once the wait is over, nobody has opened the session (or answered the prompt)
   * on any device — so nothing is sent about what you are already looking at.
   */
  delay_seconds: number;
  telegram: boolean;
  ntfy: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  events: { done: true, approval_request: true, question: true, schedule: true, jira: true },
  delay_seconds: 60,
  telegram: true,
  ntfy: true,
};

export const MAX_NOTIFICATION_DELAY_SECONDS = 3600;

export const NOTIFICATION_DELAY_OPTIONS: readonly { seconds: number; label: string }[] = [
  { seconds: 0, label: "Right away" },
  { seconds: 30, label: "After 30 seconds" },
  { seconds: 60, label: "After 1 minute" },
  { seconds: 120, label: "After 2 minutes" },
  { seconds: 300, label: "After 5 minutes" },
];

export const NOTIFICATION_EVENT_COPY: Record<NotificationEvent, { label: string; note: string }> = {
  done: { label: "Chat finished", note: "The AI finished answering." },
  approval_request: { label: "Needs approval", note: "A tool is waiting for your permission." },
  question: { label: "AI has a question", note: "The AI asked you something and is waiting." },
  schedule: { label: "Scheduled run finished", note: "A schedule completed or failed." },
  jira: { label: "Jira", note: "A watcher found new issues, or a debug run finished." },
};

function isValidDelay(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_NOTIFICATION_DELAY_SECONDS;
}

/** Fill in anything missing or malformed with the defaults. Rows written by older builds have no row at all. */
export function resolveNotificationSettings(raw: unknown): NotificationSettings {
  const src = raw && typeof raw === "object" ? (raw as Partial<Record<keyof NotificationSettings, unknown>>) : {};
  const events = { ...DEFAULT_NOTIFICATION_SETTINGS.events };
  if (src.events && typeof src.events === "object") {
    for (const key of NOTIFICATION_EVENTS) {
      const value = (src.events as Record<string, unknown>)[key];
      if (typeof value === "boolean") events[key] = value;
    }
  }
  return {
    events,
    delay_seconds: isValidDelay(src.delay_seconds) ? src.delay_seconds : DEFAULT_NOTIFICATION_SETTINGS.delay_seconds,
    telegram: typeof src.telegram === "boolean" ? src.telegram : DEFAULT_NOTIFICATION_SETTINGS.telegram,
    ntfy: typeof src.ntfy === "boolean" ? src.ntfy : DEFAULT_NOTIFICATION_SETTINGS.ntfy,
  };
}

/** A partial update: any field, and any subset of the events. */
export interface NotificationSettingsPatch {
  events?: Partial<Record<NotificationEvent, boolean>>;
  delay_seconds?: number;
  telegram?: boolean;
  ntfy?: boolean;
}

/**
 * Validate a settings update from the browser. Unknown keys are refused rather than
 * ignored, so a typo in a client does not look like a successful save.
 */
export function parseNotificationSettingsPatch(
  body: unknown,
): { ok: true; patch: NotificationSettingsPatch } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Expected an object" };
  const patch: NotificationSettingsPatch = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (key === "delay_seconds") {
      if (!isValidDelay(value)) return { ok: false, error: `delay_seconds must be a whole number from 0 to ${MAX_NOTIFICATION_DELAY_SECONDS}` };
      patch.delay_seconds = value;
    } else if (key === "telegram" || key === "ntfy") {
      if (typeof value !== "boolean") return { ok: false, error: `${key} must be true or false` };
      patch[key] = value;
    } else if (key === "events") {
      if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "events must be an object" };
      const events: Partial<Record<NotificationEvent, boolean>> = {};
      for (const [event, on] of Object.entries(value as Record<string, unknown>)) {
        if (!(NOTIFICATION_EVENTS as readonly string[]).includes(event)) return { ok: false, error: `Unknown event: ${event}` };
        if (typeof on !== "boolean") return { ok: false, error: `events.${event} must be true or false` };
        events[event as NotificationEvent] = on;
      }
      patch.events = events;
    } else {
      return { ok: false, error: `Unknown setting: ${key}` };
    }
  }
  return { ok: true, patch };
}

export function applyNotificationSettingsPatch(
  current: NotificationSettings,
  patch: NotificationSettingsPatch,
): NotificationSettings {
  return {
    events: { ...current.events, ...(patch.events ?? {}) },
    delay_seconds: patch.delay_seconds ?? current.delay_seconds,
    telegram: patch.telegram ?? current.telegram,
    ntfy: patch.ntfy ?? current.ntfy,
  };
}

/** One browser that receives push, as the Settings pane lists it. Keys never leave the server. */
export interface PushDeviceInfo {
  id: string;
  label: string;
  /** The push service URL. Not a secret without the server's VAPID key; it is how a browser finds its own row. */
  endpoint: string;
  origin: string;
  createdAt: number;
  lastSuccessAt: number | null;
  lastError: string | null;
}

export interface PushStatus {
  publicKey: string;
  devices: PushDeviceInfo[];
}

export interface TelegramChatInfo {
  chatId: string;
  name: string;
}

export interface TelegramNotifyStatus {
  configured: boolean;
  botUsername: string | null;
  /** PPMBot answers through this same bot, so alerts land in its chats. */
  sharedWithPPMBot: boolean;
  chats: TelegramChatInfo[];
  connect: { active: boolean; expiresAt: number | null; error: string | null };
}

/** ntfy as the Settings pane sees it. The access token never leaves the server. */
export interface NtfyStatus {
  configured: boolean;
  server: string;
  topic: string;
  tokenSet: boolean;
}

/** ntfy's own rule for a topic name. */
export const NTFY_TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;

/**
 * The server's base URL as typed — `ntfy.example.com`, `https://ntfy.sh/` — reduced to
 * `https://host[/path]`. Null for anything that is not an http(s) address.
 */
export function normalizeNtfyServer(value: string): string | null {
  const typed = value.trim();
  if (!typed) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname || url.username || url.password) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}
