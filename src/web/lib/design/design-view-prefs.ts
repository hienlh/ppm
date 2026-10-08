import { isDeviceFrameId, type DeviceFrameId } from "@/components/design/canvas/device-frame-presets";
import { isDesignLayoutOverride, type DesignLayoutOverride } from "./design-layout-mode";

/**
 * How this device likes its design tabs laid out: the layout picked from the toolbar's
 * menu, the chat pane's share of the split, and the device frame and variant last chosen per
 * design.
 *
 * Device-local on purpose (plain localStorage, never the server prefs): a desktop that
 * likes a wide chat and a Tablet frame says nothing about what a phone should show.
 * Everything read back is untrusted — a hand-edited or older blob must degrade to the
 * defaults, never throw inside a tab.
 */

const STORAGE_KEY = "ppm-design-view-prefs";
export const DEFAULT_CHAT_PERCENT = 38;
export const MIN_CHAT_PERCENT = 20;
export const MAX_CHAT_PERCENT = 70;
/**
 * The chat column's width in a design *window*, in px: a fixed column rather than a share,
 * because a window is resized far more often than the column is, and the chat should not
 * swell and shrink with it. It never takes more than half the window either (see the layout).
 */
export const DEFAULT_WINDOW_CHAT_WIDTH = 380;
export const MIN_WINDOW_CHAT_WIDTH = 280;
export const MAX_WINDOW_CHAT_WIDTH = 440;
/** Designs whose frame is remembered; the least recently changed are forgotten first. */
export const MAX_REMEMBERED_FRAMES = 50;

export interface DesignViewPrefs {
  layout: DesignLayoutOverride;
  chatPercent: number;
  windowChatWidth: number;
  /** `<project>/<slug>` → frame, oldest first. */
  frames: Record<string, DeviceFrameId>;
  /** `<project>/<slug>` → the variant file on screen, oldest first. Checked against the list on use. */
  variants: Record<string, string>;
}

export function defaultDesignViewPrefs(): DesignViewPrefs {
  return { layout: "auto", chatPercent: DEFAULT_CHAT_PERCENT, windowChatWidth: DEFAULT_WINDOW_CHAT_WIDTH, frames: {}, variants: {} };
}

/** Newest-last entries of a stored map, the ones failing `keep` dropped, at most MAX_REMEMBERED_FRAMES. */
function rememberedMap<T>(value: unknown, keep: (v: unknown) => v is T): Record<string, T> {
  const out: Record<string, T> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  const entries = Object.entries(value as Record<string, unknown>).filter((e): e is [string, T] => e[0].length <= 300 && keep(e[1]));
  for (const [key, v] of entries.slice(-MAX_REMEMBERED_FRAMES)) out[key] = v;
  return out;
}

const isStoredVariant = (v: unknown): v is string => typeof v === "string" && v.length <= 120;

export function clampChatPercent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CHAT_PERCENT;
  return Math.min(MAX_CHAT_PERCENT, Math.max(MIN_CHAT_PERCENT, Math.round(value)));
}

export function clampWindowChatWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_WINDOW_CHAT_WIDTH;
  return Math.min(MAX_WINDOW_CHAT_WIDTH, Math.max(MIN_WINDOW_CHAT_WIDTH, Math.round(value)));
}

export function parseDesignViewPrefs(raw: string | null): DesignViewPrefs {
  if (!raw) return defaultDesignViewPrefs();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return defaultDesignViewPrefs();
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return defaultDesignViewPrefs();
  const obj = data as Record<string, unknown>;
  const layout = isDesignLayoutOverride(obj.layout) ? obj.layout : "auto";
  return {
    layout, chatPercent: clampChatPercent(obj.chatPercent),
    windowChatWidth: clampWindowChatWidth(obj.windowChatWidth),
    frames: rememberedMap(obj.frames, isDeviceFrameId),
    variants: rememberedMap(obj.variants, isStoredVariant),
  };
}

export function designFrameKey(projectName: string, slug: string): string {
  return `${projectName}/${slug}`;
}

/** Remember `frame` for a design, moving it to the newest position and trimming the oldest. */
export function withFrame(prefs: DesignViewPrefs, key: string, frame: DeviceFrameId): DesignViewPrefs {
  const entries = Object.entries(prefs.frames).filter(([k]) => k !== key);
  entries.push([key, frame]);
  return { ...prefs, frames: Object.fromEntries(entries.slice(-MAX_REMEMBERED_FRAMES)) };
}

/** Remember the variant on screen for a design, newest last, trimming the oldest. */
export function withVariant(prefs: DesignViewPrefs, key: string, file: string): DesignViewPrefs {
  const entries = Object.entries(prefs.variants).filter(([k]) => k !== key);
  entries.push([key, file]);
  return { ...prefs, variants: Object.fromEntries(entries.slice(-MAX_REMEMBERED_FRAMES)) };
}

export function withoutVariant(prefs: DesignViewPrefs, key: string): DesignViewPrefs {
  if (!(key in prefs.variants)) return prefs;
  return { ...prefs, variants: Object.fromEntries(Object.entries(prefs.variants).filter(([k]) => k !== key)) };
}

export function withChatPercent(prefs: DesignViewPrefs, percent: number): DesignViewPrefs {
  return { ...prefs, chatPercent: clampChatPercent(percent) };
}

export function withWindowChatWidth(prefs: DesignViewPrefs, width: number): DesignViewPrefs {
  return { ...prefs, windowChatWidth: clampWindowChatWidth(width) };
}

export function withLayout(prefs: DesignViewPrefs, layout: DesignLayoutOverride): DesignViewPrefs {
  return { ...prefs, layout };
}

export function loadDesignViewPrefs(): DesignViewPrefs {
  try {
    return parseDesignViewPrefs(localStorage.getItem(STORAGE_KEY));
  } catch {
    return defaultDesignViewPrefs();
  }
}

export function saveDesignViewPrefs(prefs: DesignViewPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or disabled: the layout simply is not remembered.
  }
}
