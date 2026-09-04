/**
 * Manual localStorage persistence for floating windows.
 *
 * Hand-rolled instead of zustand's `persist` because the saved rects must be re-clamped
 * against the *current* layer size on load (a rect saved on a 4K screen is off-screen on a
 * laptop), and because only gesture-end commits should hit storage, not every drag frame.
 */

import { clampRect, type Bounds, type Rect } from "./window-geometry";
import { WINDOW_KINDS } from "./window-store-types";
import type { WindowKind, WindowRuntimeState, WindowVisualState } from "./window-store-types";

const STORAGE_KEY = "ppm-windows";

/** Only JSON-safe payloads survive a reload — anything else is dropped with the window. */
export interface PersistedWindow {
  id: string;
  kind: WindowKind;
  rect: Rect;
  state: WindowVisualState;
  payload?: Record<string, unknown>;
}

/**
 * Kinds that may come back after a reload. Derived from WINDOW_KINDS so a new kind is
 * restorable by default; `team-member` is the one exclusion, because its body streams a
 * live subagent session that no longer exists after a reload — restoring it would open
 * an empty shell the user never asked for.
 */
const RESTORABLE_KINDS: readonly WindowKind[] = WINDOW_KINDS.filter((k) => k !== "team-member");
const STATES: WindowVisualState[] = ["normal", "maximized", "minimized"];

function isRect(v: unknown): v is Rect {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (["x", "y", "w", "h"] as const).every((k) => typeof r[k] === "number" && Number.isFinite(r[k]));
}

function isSerialisable(payload: unknown): payload is Record<string, unknown> | undefined {
  if (payload === undefined) return true;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  try {
    JSON.stringify(payload);
    return true;
  } catch {
    return false; // cyclic or non-serialisable payload (e.g. a live handle)
  }
}

function toPersisted(win: WindowRuntimeState): PersistedWindow | null {
  if (!isSerialisable(win.payload)) return null;
  return { id: win.id, kind: win.kind, rect: win.rect, state: win.state, payload: win.payload };
}

export function saveWindowRects(windows: WindowRuntimeState[]): void {
  try {
    // Persisted back-to-front so the restored rank order matches what the user last saw.
    const ordered = [...windows].sort((a, b) => a.rank - b.rank);
    const payload = ordered.map(toPersisted).filter((w): w is PersistedWindow => w !== null);
    if (payload.length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* quota exceeded or storage disabled — geometry is cosmetic, never block the UI */
  }
}

/** Read persisted windows, dropping anything malformed, and re-clamp to the current layer. */
export function loadWindowRects(bounds: Bounds): PersistedWindow[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: PersistedWindow[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const w = item as Record<string, unknown>;
    if (typeof w.id !== "string" || !RESTORABLE_KINDS.includes(w.kind as WindowKind)) continue;
    if (!isRect(w.rect) || !isSerialisable(w.payload)) continue;
    const state = STATES.includes(w.state as WindowVisualState)
      ? (w.state as WindowVisualState)
      : "normal";
    out.push({
      id: w.id,
      kind: w.kind as WindowKind,
      rect: clampRect(w.rect, bounds),
      state,
      payload: w.payload as Record<string, unknown> | undefined,
    });
  }
  return out;
}

export function clearWindowRects(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage disabled */
  }
}
