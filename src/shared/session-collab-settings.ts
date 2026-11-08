/**
 * Settings for sessions that open and message each other (`ai.session_collab`). Shared so the
 * Settings pane edits the same shape, defaults and ranges the server enforces.
 */

export interface SessionCollabSettings {
  /** Ask the user before an AI creates a session. */
  askBeforeCreate: boolean;
  /** How deep a chain of AI-created sessions may go (a session the user started is depth 0). */
  maxDepth: number;
  /** Messages two sessions may send each other automatically before the user is asked. */
  maxAutoMessagesPerPair: number;
  /** AI-created sessions of one project that may be running at once. */
  maxRunningSpawned: number;
  /** Longest a `send_to_session` call with `wait: true` waits for a reply, in minutes. */
  waitTimeoutMinutes: number;
}

export type SessionCollabNumericSetting = Exclude<keyof SessionCollabSettings, "askBeforeCreate">;

export const SESSION_COLLAB_DEFAULTS: Readonly<SessionCollabSettings> = Object.freeze({
  askBeforeCreate: true,
  maxDepth: 3,
  maxAutoMessagesPerPair: 20,
  maxRunningSpawned: 5,
  waitTimeoutMinutes: 10,
});

/** The inclusive range each number is clamped to. */
export const SESSION_COLLAB_LIMITS: Readonly<Record<SessionCollabNumericSetting, { min: number; max: number }>> = Object.freeze({
  maxDepth: { min: 1, max: 5 },
  maxAutoMessagesPerPair: { min: 1, max: 200 },
  maxRunningSpawned: { min: 1, max: 20 },
  waitTimeoutMinutes: { min: 1, max: 60 },
});

const NUMERIC_KEYS = Object.keys(SESSION_COLLAB_LIMITS) as SessionCollabNumericSetting[];

/** A whole number inside the setting's range: rounded, then clamped. */
export function clampSessionCollabNumber(key: SessionCollabNumericSetting, value: number): number {
  const { min, max } = SESSION_COLLAB_LIMITS[key];
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * The settings in force: every field the stored value lacks or holds in the wrong type takes its
 * default, and every number is clamped. Never throws, whatever was stored.
 */
export function resolveSessionCollabSettings(stored: unknown): SessionCollabSettings {
  const raw = stored && typeof stored === "object" && !Array.isArray(stored) ? stored as Record<string, unknown> : {};
  const out: SessionCollabSettings = { ...SESSION_COLLAB_DEFAULTS };
  if (typeof raw.askBeforeCreate === "boolean") out.askBeforeCreate = raw.askBeforeCreate;
  for (const key of NUMERIC_KEYS) {
    const v = raw[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = clampSessionCollabNumber(key, v);
  }
  return out;
}

/**
 * A partial update as the Settings route receives it: an object naming only known fields, each of
 * the right type. Numbers are clamped rather than refused, so a slider pushed past its end saves
 * the end. Returns the error to answer with instead when the body is not one.
 */
export function parseSessionCollabPatch(
  body: unknown,
): { ok: true; patch: Partial<SessionCollabSettings> } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "session_collab must be an object" };
  const patch: Partial<SessionCollabSettings> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (key === "askBeforeCreate") {
      if (typeof value !== "boolean") return { ok: false, error: "session_collab.askBeforeCreate must be a boolean" };
      patch.askBeforeCreate = value;
    } else if ((NUMERIC_KEYS as string[]).includes(key)) {
      const k = key as SessionCollabNumericSetting;
      if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, error: `session_collab.${k} must be a number` };
      patch[k] = clampSessionCollabNumber(k, value);
    } else {
      return { ok: false, error: `session_collab has no setting named "${key}"` };
    }
  }
  return { ok: true, patch };
}
