/**
 * Connections between two PPMs ("peer connections"): the row shapes, the per-connection settings,
 * their preset defaults and the ranges the server clamps them to. Shared so the Settings form and
 * the server read the same defaults and limits.
 */

export type PeerConnectionStatus = "pending_confirm" | "active" | "paused" | "closed";
export type PeerRole = "inviter" | "acceptor";
export type PeerTransportKind = "relay" | "tailscale";
export type PeerActor = "user" | "assistant";

/** "Mine": both machines are the user's own. "Other": someone else's machine. */
export type PeerPreset = "mine" | "other";
/** `machine` ("whole machine") is offered for the `mine` preset only. */
export type PeerScope = "project" | "machine";
/** What the connection chat may do with tools: refuse writes, ask on a card, or act within scope. */
export type PeerPermission = "read" | "ask" | "auto";
/** Messages this side sends: a card for each, a card only when the secret scan hits, or none. */
export type PeerOutgoing = "ask" | "filtered" | "free";

export const PEER_CONNECTION_STATUSES: readonly PeerConnectionStatus[] = ["pending_confirm", "active", "paused", "closed"];
export const PEER_PRESETS: readonly PeerPreset[] = ["mine", "other"];
export const PEER_SCOPES: readonly PeerScope[] = ["project", "machine"];
export const PEER_PERMISSIONS: readonly PeerPermission[] = ["read", "ask", "auto"];
export const PEER_OUTGOING: readonly PeerOutgoing[] = ["ask", "filtered", "free"];

export interface PeerConnectionSettings {
  preset: PeerPreset;
  scope: PeerScope;
  permission: PeerPermission;
  outgoing: PeerOutgoing;
  allowChildSessions: boolean;
  dailyMsgLimit: number;
  /** Input + output tokens, plus a share of cache reads, per local day. */
  dailyTokenLimit: number;
  /** Automatic exchanges in a row before the chats stop; reset when a person types. */
  maxAutoExchanges: number;
  /** Quiet hours as minutes after local midnight, or null for none. */
  quietStart: number | null;
  quietEnd: number | null;
  /** Null: the provider's default. */
  model: string | null;
  accountId: string | null;
  instructions: string;
}

export type PeerNumericSetting = "dailyMsgLimit" | "dailyTokenLimit" | "maxAutoExchanges";

export const PEER_SETTING_LIMITS: Readonly<Record<PeerNumericSetting, { min: number; max: number }>> = Object.freeze({
  dailyMsgLimit: { min: 1, max: 5_000 },
  dailyTokenLimit: { min: 10_000, max: 50_000_000 },
  maxAutoExchanges: { min: 1, max: 200 },
});

export const PEER_INSTRUCTIONS_MAX_CHARS = 4_000;
const MINUTES_PER_DAY = 24 * 60;

/** What a new connection starts with, by the preset chosen while pairing. */
export const PEER_PRESET_DEFAULTS: Readonly<Record<PeerPreset, Readonly<PeerConnectionSettings>>> = Object.freeze({
  mine: Object.freeze({
    preset: "mine", scope: "project", permission: "auto", outgoing: "free", allowChildSessions: true,
    dailyMsgLimit: 200, dailyTokenLimit: 2_000_000, maxAutoExchanges: 10,
    quietStart: null, quietEnd: null, model: null, accountId: null, instructions: "",
  }),
  other: Object.freeze({
    preset: "other", scope: "project", permission: "read", outgoing: "ask", allowChildSessions: false,
    dailyMsgLimit: 20, dailyTokenLimit: 200_000, maxAutoExchanges: 10,
    quietStart: null, quietEnd: null, model: null, accountId: null, instructions: "",
  }),
});

export function clampPeerNumber(key: PeerNumericSetting, value: number): number {
  const { min, max } = PEER_SETTING_LIMITS[key];
  return Math.min(max, Math.max(min, Math.round(value)));
}

const oneOf = <T extends string>(list: readonly T[], value: unknown, fallback: T): T =>
  typeof value === "string" && (list as readonly string[]).includes(value) ? value as T : fallback;

function minuteOfDay(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value >= 0 && value < MINUTES_PER_DAY ? value : null;
}

const optionalText = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

/**
 * The settings in force: anything missing or of the wrong type takes the preset's default, numbers
 * are clamped, and `machine` scope is dropped to `project` unless the preset is `mine`. Quiet hours
 * need both ends or neither. Never throws.
 */
export function resolvePeerSettings(stored: unknown, presetHint: PeerPreset = "other"): PeerConnectionSettings {
  const raw = stored && typeof stored === "object" && !Array.isArray(stored) ? stored as Record<string, unknown> : {};
  const preset = oneOf(PEER_PRESETS, raw.preset, presetHint);
  const base = PEER_PRESET_DEFAULTS[preset];
  const num = (key: PeerNumericSetting): number =>
    typeof raw[key] === "number" && Number.isFinite(raw[key]) ? clampPeerNumber(key, raw[key] as number) : base[key];
  const scope = oneOf(PEER_SCOPES, raw.scope, base.scope);
  let quietStart = minuteOfDay(raw.quietStart);
  let quietEnd = minuteOfDay(raw.quietEnd);
  if (quietStart === null || quietEnd === null || quietStart === quietEnd) quietStart = quietEnd = null;
  return {
    preset,
    scope: preset === "mine" ? scope : "project",
    permission: oneOf(PEER_PERMISSIONS, raw.permission, base.permission),
    outgoing: oneOf(PEER_OUTGOING, raw.outgoing, base.outgoing),
    allowChildSessions: typeof raw.allowChildSessions === "boolean" ? raw.allowChildSessions : base.allowChildSessions,
    dailyMsgLimit: num("dailyMsgLimit"),
    dailyTokenLimit: num("dailyTokenLimit"),
    maxAutoExchanges: num("maxAutoExchanges"),
    quietStart,
    quietEnd,
    model: optionalText(raw.model, 200),
    accountId: optionalText(raw.accountId, 200),
    instructions: typeof raw.instructions === "string" ? raw.instructions.slice(0, PEER_INSTRUCTIONS_MAX_CHARS) : "",
  };
}

/** The 16-hex-character fingerprint shown in the UI, grouped for reading aloud: `a1b2 c3d4 …`. */
export function formatPeerFingerprint(fingerprint: string): string {
  return fingerprint.toLowerCase().replace(/(.{4})(?=.)/g, "$1 ");
}
