/**
 * Floating window state: geometry, stacking order and lifecycle for the desktop window layer.
 *
 * Content-agnostic on purpose — the store knows a `kind` and an opaque payload, the registry
 * decides what renders inside. Ranks are kept dense (0..n-1) so the inline z-index never
 * escapes the band reserved below the app's click-away backdrops.
 */

import { create } from "zustand";
import {
  cascadeSpawnRect,
  clampRect,
  MAX_WINDOWS,
  type Bounds,
  type Rect,
} from "./window-geometry";
import { loadWindowRects, saveWindowRects } from "./window-persistence";
import type { WindowKind, WindowRuntimeState, WindowVisualState } from "./window-store-types";

export type { WindowKind, WindowRuntimeState, WindowVisualState };

/** Fallback layer size used before the container has been measured. */
const DEFAULT_BOUNDS: Bounds = { w: 1280, h: 800 };

interface WindowStore {
  windows: Record<string, WindowRuntimeState>;
  /** Measured size of the layer container; all rects are clamped against it. */
  bounds: Bounds;
  /** True once persisted windows have been read, so restore runs exactly once. */
  restored: boolean;

  open(kind: WindowKind, payload?: Record<string, unknown>, rect?: Rect): string;
  close(id: string): void;
  focus(id: string): void;
  move(id: string, position: { x: number; y: number }): void;
  resize(id: string, rect: Rect): void;
  setState(id: string, state: WindowVisualState): void;
  setBounds(bounds: Bounds): void;
  /** Re-hydrate persisted windows into the layer (no-op after the first call). */
  restoreAll(bounds: Bounds): void;
}

const sortedByRank = (windows: Record<string, WindowRuntimeState>): WindowRuntimeState[] =>
  Object.values(windows).sort((a, b) => a.rank - b.rank);

/** Rewrite ranks to 0..n-1 in the given order (last = frontmost). */
function densify(ordered: WindowRuntimeState[]): Record<string, WindowRuntimeState> {
  const out: Record<string, WindowRuntimeState> = {};
  ordered.forEach((win, rank) => {
    out[win.id] = win.rank === rank ? win : { ...win, rank };
  });
  return out;
}

function persist(windows: Record<string, WindowRuntimeState>): void {
  saveWindowRects(Object.values(windows));
}

function newId(): string {
  return `win-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useWindowStore = create<WindowStore>((set, get) => ({
  windows: {},
  bounds: DEFAULT_BOUNDS,
  restored: false,

  open: (kind, payload, rect) => {
    const { windows, bounds } = get();
    const ordered = sortedByRank(windows);

    // At the cap the layer would leave its z band, so the oldest window is raised instead
    // of silently dropping the request.
    if (ordered.length >= MAX_WINDOWS) {
      const oldest = ordered[0]!;
      get().focus(oldest.id);
      return oldest.id;
    }

    const id = newId();
    const spawn = rect ? clampRect(rect, bounds) : cascadeSpawnRect(ordered.map((w) => w.rect), bounds);
    const next = densify([
      ...ordered,
      { id, kind, rect: spawn, rank: ordered.length, state: "normal" as const, payload },
    ]);
    set({ windows: next });
    persist(next);
    return id;
  },

  close: (id) => {
    const { windows } = get();
    if (!windows[id]) return;
    const next = densify(sortedByRank(windows).filter((w) => w.id !== id));
    set({ windows: next });
    persist(next);
  },

  focus: (id) => {
    const { windows } = get();
    const target = windows[id];
    if (!target) return;
    const ordered = sortedByRank(windows);
    if (ordered[ordered.length - 1]?.id === id) return; // already frontmost
    const next = densify([...ordered.filter((w) => w.id !== id), target]);
    set({ windows: next });
    persist(next); // stacking order is part of the restored layout
  },

  move: (id, position) => {
    const { windows, bounds } = get();
    const win = windows[id];
    if (!win) return;
    const rect = clampRect({ ...win.rect, ...position }, bounds);
    const next = { ...windows, [id]: { ...win, rect } };
    set({ windows: next });
    persist(next);
  },

  resize: (id, rect) => {
    const { windows, bounds } = get();
    const win = windows[id];
    if (!win) return;
    const next = { ...windows, [id]: { ...win, rect: clampRect(rect, bounds) } };
    set({ windows: next });
    persist(next);
  },

  setState: (id, state) => {
    const { windows } = get();
    const win = windows[id];
    if (!win || win.state === state) return;
    const next = { ...windows, [id]: { ...win, state } };
    set({ windows: next });
    persist(next);
  },

  setBounds: (bounds) => {
    const current = get();
    if (current.bounds.w === bounds.w && current.bounds.h === bounds.h) return;
    // A shrinking content area (sidebar opened, browser resized) would otherwise strand
    // windows outside the layer with no way to drag them back.
    const windows: Record<string, WindowRuntimeState> = {};
    for (const win of Object.values(current.windows)) {
      const rect = clampRect(win.rect, bounds);
      windows[win.id] =
        rect.x === win.rect.x && rect.y === win.rect.y && rect.w === win.rect.w && rect.h === win.rect.h
          ? win
          : { ...win, rect };
    }
    set({ bounds, windows });
  },

  restoreAll: (bounds) => {
    if (get().restored) return;
    const saved = loadWindowRects(bounds).slice(0, MAX_WINDOWS);
    const windows = densify(
      saved.map((w, rank) => ({
        id: w.id,
        kind: w.kind,
        rect: w.rect,
        rank,
        state: w.state,
        payload: w.payload,
      })),
    );
    set({ bounds, windows, restored: true });
  },
}));

/** Windows in paint order (backmost first) — stable identity per store update. */
export function windowsInRankOrder(windows: Record<string, WindowRuntimeState>): WindowRuntimeState[] {
  return sortedByRank(windows);
}
