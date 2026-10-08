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
import { isPipOnlyWindow } from "./window-pip-registry";
import type { WindowKind, WindowRuntimeState, WindowShownState, WindowVisualState } from "./window-store-types";

export type { WindowKind, WindowRuntimeState, WindowShownState, WindowVisualState };

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
  /** Raise a window to the front, bringing it back from the dock if it was minimized. */
  focus(id: string): void;
  move(id: string, position: { x: number; y: number }): void;
  resize(id: string, rect: Rect): void;
  /** Change how a window is shown. Minimizing remembers the state to come back to. */
  setState(id: string, state: WindowVisualState): void;
  /** Bring a window back from the dock in the state it was minimized from, and raise it. */
  restore(id: string): void;
  /** A dock chip's click: the window in front minimizes, any other comes forward. */
  activateFromDock(id: string): void;
  minimizeAll(): void;
  /** The window being dragged towards a snap, or null; drives the layer's snap preview. */
  snapPreviewId: string | null;
  setSnapPreview(id: string | null): void;
  /** Merge into a window's payload; persisted so a reload restores the latest state. */
  setPayload(id: string, payload: Record<string, unknown>): void;
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

/** The next open-order number: one past the newest window, so the dock appends it. */
function nextOpened(windows: WindowRuntimeState[]): number {
  return windows.reduce((max, w) => Math.max(max, w.opened + 1), 0);
}

/** `win` in `state`, remembering what a minimized window was showing as. */
function withState(win: WindowRuntimeState, state: WindowVisualState): WindowRuntimeState {
  if (win.state === state) return win;
  if (state === "minimized") return { ...win, state, restoreTo: win.state as WindowShownState };
  const { restoreTo: _dropped, ...rest } = win;
  return { ...rest, state };
}

function newId(): string {
  return `win-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useWindowStore = create<WindowStore>((set, get) => ({
  windows: {},
  bounds: DEFAULT_BOUNDS,
  restored: false,
  snapPreviewId: null,

  open: (kind, payload, rect) => {
    const { windows, bounds } = get();
    const ordered = sortedByRank(windows);

    // At the cap the layer would leave its z band, so the oldest window is raised instead
    // of silently dropping the request.
    if (ordered.length >= MAX_WINDOWS) {
      const oldest = ordered[0]!;
      get().restore(oldest.id);
      return oldest.id;
    }

    const id = newId();
    const spawn = rect ? clampRect(rect, bounds) : cascadeSpawnRect(ordered.map((w) => w.rect), bounds);
    const next = densify([
      ...ordered,
      { id, kind, rect: spawn, rank: ordered.length, opened: nextOpened(ordered), state: "normal" as const, payload },
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
    const found = windows[id];
    if (!found) return;
    // Every opener that finds its window already open focuses it; one waiting in the dock
    // has to come back on screen for that to mean anything.
    const target = found.state === "minimized" ? withState(found, found.restoreTo ?? "normal") : found;
    const ordered = sortedByRank(windows);
    if (target === found && ordered[ordered.length - 1]?.id === id) return; // already frontmost
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
    const next = { ...windows, [id]: withState(win, state) };
    set({ windows: next });
    persist(next);
  },

  restore: (id) => get().focus(id),

  activateFromDock: (id) => {
    const { windows } = get();
    if (!windows[id]) return;
    if (frontWindowId(windows) === id) get().setState(id, "minimized");
    else get().restore(id);
  },

  minimizeAll: () => {
    const { windows } = get();
    const next: Record<string, WindowRuntimeState> = {};
    for (const win of Object.values(windows)) next[win.id] = withState(win, "minimized");
    set({ windows: next });
    persist(next);
  },

  setSnapPreview: (id) => {
    if (get().snapPreviewId !== id) set({ snapPreviewId: id });
  },

  setPayload: (id, payload) => {
    const { windows } = get();
    const win = windows[id];
    if (!win) return;
    const merged = { ...win.payload, ...payload };
    // Content re-renders on every keystroke in some bodies; skip the write when the
    // payload is unchanged so persistence is not hit for nothing.
    const unchanged = Object.entries(merged).every(
      ([key, value]) => win.payload?.[key] === value,
    );
    if (unchanged && Object.keys(merged).length === Object.keys(win.payload ?? {}).length) return;
    const next = { ...windows, [id]: { ...win, payload: merged } };
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
        // A blob from before open order was kept has none; stacking order stands in for it.
        opened: w.opened ?? rank,
        state: w.state,
        restoreTo: w.restoreTo,
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

/**
 * The window in front: the highest-ranked one still on screen. A minimized window keeps its
 * rank so it comes back where it was in the stack, but it is never the one in front.
 */
export function frontWindowId(windows: Record<string, WindowRuntimeState>): string | null {
  // A window that only carries a tab into picture-in-picture is never on screen either.
  const shown = sortedByRank(windows).filter((w) => w.state !== "minimized" && !isPipOnlyWindow(w.id));
  return shown[shown.length - 1]?.id ?? null;
}

/** Windows in the order they were opened — the order the dock lists them in. */
export function windowsInOpenOrder(windows: Record<string, WindowRuntimeState>): WindowRuntimeState[] {
  return Object.values(windows).sort((a, b) => a.opened - b.opened);
}
