/**
 * Settings of PPM's own web browser: a Chrome PPM runs on the host and streams into a window
 * (desktop) or a tab (phone). Stored as the `web_browser` config row and always read through
 * `parseWebBrowserSettings`, which clamps every number and drops unknown keys, because the row is
 * writable from the CLI and from older builds.
 *
 * `enabled` left undefined means "not decided yet": the onboarding tour asks once (FEATURE_INTROS)
 * and only an explicit true lets the browser start.
 */

export interface WebBrowserSettings {
  /** Undefined until the user answers the tour or flips the switch in Settings. */
  enabled?: boolean;
  /** Most tabs open at once; a new one past this is closed and reported. */
  maxTabs: number;
  /** Chrome is stopped after this long with nobody watching or acting in it. */
  idleStopMinutes: number;
  /** Ceiling on screencast frames per second. */
  fpsCap: number;
  /** JPEG quality of each frame, 30–85. */
  jpegQuality: number;
  /** Pages may open services on this machine (loopback and its own addresses), except PPM's ports. */
  allowLocalhost: boolean;
  /** Pages may open the home/office network: private, CGNAT (Tailscale) and link-local ranges. */
  allowLan: boolean;
  /** The browser may be used from a request that came through a public tunnel or proxy. */
  allowPublicTunnel: boolean;
  /** Pages' sound is captured and played on the viewing device. */
  audio: boolean;
  /** AI chats may drive the browser (each chat is asked once before its first use). */
  aiControl: boolean;
  /** One of the paths `chrome-locate` found; null picks the first one found. */
  browserPath: string | null;
}

export const WEB_BROWSER_LIMITS = {
  maxTabs: [1, 8],
  idleStopMinutes: [2, 120],
  fpsCap: [5, 30],
  jpegQuality: [30, 85],
} as const satisfies Record<string, readonly [number, number]>;

/** The user chose these on 24/11/2026 (cards 42874305, dccf1ef2, 2b73ffa8): everything on. */
export const DEFAULT_WEB_BROWSER_SETTINGS: Readonly<WebBrowserSettings> = Object.freeze({
  maxTabs: 4,
  idleStopMinutes: 10,
  fpsCap: 12,
  jpegQuality: 55,
  allowLocalhost: true,
  allowLan: true,
  allowPublicTunnel: true,
  audio: true,
  aiControl: true,
  browserPath: null,
});

/** Picture presets offered in Settings. */
export const WEB_BROWSER_QUALITY_PRESETS = {
  saver: { fpsCap: 8, jpegQuality: 45 },
  balanced: { fpsCap: 12, jpegQuality: 55 },
  smooth: { fpsCap: 20, jpegQuality: 65 },
} as const;

function clampInt(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** A stored or submitted value as settings PPM can act on. Never throws. */
export function parseWebBrowserSettings(raw: unknown): WebBrowserSettings {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_WEB_BROWSER_SETTINGS;
  const path = typeof value.browserPath === "string" && value.browserPath.trim() !== "" && value.browserPath.length <= 1024
    ? value.browserPath
    : null;
  const settings: WebBrowserSettings = {
    maxTabs: clampInt(value.maxTabs, WEB_BROWSER_LIMITS.maxTabs, d.maxTabs),
    idleStopMinutes: clampInt(value.idleStopMinutes, WEB_BROWSER_LIMITS.idleStopMinutes, d.idleStopMinutes),
    fpsCap: clampInt(value.fpsCap, WEB_BROWSER_LIMITS.fpsCap, d.fpsCap),
    jpegQuality: clampInt(value.jpegQuality, WEB_BROWSER_LIMITS.jpegQuality, d.jpegQuality),
    allowLocalhost: bool(value.allowLocalhost, d.allowLocalhost),
    allowLan: bool(value.allowLan, d.allowLan),
    allowPublicTunnel: bool(value.allowPublicTunnel, d.allowPublicTunnel),
    audio: bool(value.audio, d.audio),
    aiControl: bool(value.aiControl, d.aiControl),
    browserPath: path,
  };
  if (typeof value.enabled === "boolean") settings.enabled = value.enabled;
  return settings;
}

/** True only once the user has turned the browser on. */
export function webBrowserTurnedOn(settings: WebBrowserSettings): boolean {
  return settings.enabled === true;
}
