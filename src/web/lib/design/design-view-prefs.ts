import { isDeviceFrameId, type DeviceFrameId } from "@/components/design/canvas/device-frame-presets";

/**
 * How this device likes its design tabs laid out: the chat pane's share of the split and
 * the device frame last chosen per design.
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
/** Designs whose frame is remembered; the least recently changed are forgotten first. */
export const MAX_REMEMBERED_FRAMES = 50;

export interface DesignViewPrefs {
  chatPercent: number;
  /** `<project>/<slug>` → frame, oldest first. */
  frames: Record<string, DeviceFrameId>;
}

export function defaultDesignViewPrefs(): DesignViewPrefs {
  return { chatPercent: DEFAULT_CHAT_PERCENT, frames: {} };
}

export function clampChatPercent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CHAT_PERCENT;
  return Math.min(MAX_CHAT_PERCENT, Math.max(MIN_CHAT_PERCENT, Math.round(value)));
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
  const frames: Record<string, DeviceFrameId> = {};
  if (obj.frames && typeof obj.frames === "object" && !Array.isArray(obj.frames)) {
    const entries = Object.entries(obj.frames as Record<string, unknown>)
      .filter((e): e is [string, DeviceFrameId] => e[0].length <= 300 && isDeviceFrameId(e[1]));
    for (const [key, frame] of entries.slice(-MAX_REMEMBERED_FRAMES)) frames[key] = frame;
  }
  return { chatPercent: clampChatPercent(obj.chatPercent), frames };
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

export function withChatPercent(prefs: DesignViewPrefs, percent: number): DesignViewPrefs {
  return { ...prefs, chatPercent: clampChatPercent(percent) };
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
