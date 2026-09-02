/**
 * PPM's own sidebar pins — folders the user pinned inside PPM, kept apart from the
 * OS-provided pins (Quick Access / Finder Favorites / GTK-KDE bookmarks) which are
 * read-only and re-read from the host on every load.
 */

import { create } from "zustand";

export interface ExplorerPin {
  name: string;
  path: string;
}

const PINS_KEY = "ppm-explorer-pins";
const MAX_PINS = 50;

function loadPins(): ExplorerPin[] {
  try {
    const raw = localStorage.getItem(PINS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is ExplorerPin =>
        !!p && typeof (p as ExplorerPin).path === "string" && typeof (p as ExplorerPin).name === "string")
      .slice(0, MAX_PINS);
  } catch {
    return [];
  }
}

function savePins(pins: ExplorerPin[]): void {
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(pins));
  } catch {
    /* quota or private mode — pins simply do not persist */
  }
}

interface PinsStore {
  pins: ExplorerPin[];
  isPinned(path: string): boolean;
  pin(pin: ExplorerPin): void;
  unpin(path: string): void;
}

export const useExplorerPinsStore = create<PinsStore>((set, get) => ({
  pins: loadPins(),

  isPinned: (path) => get().pins.some((p) => p.path === path),

  pin: (entry) => {
    if (get().isPinned(entry.path)) return;
    const pins = [...get().pins, entry].slice(0, MAX_PINS);
    savePins(pins);
    set({ pins });
  },

  unpin: (path) => {
    const pins = get().pins.filter((p) => p.path !== path);
    savePins(pins);
    set({ pins });
  },
}));
