/**
 * Selection semantics for the explorer views — plain click, ctrl/cmd toggle, shift range,
 * arrow-key cursor and type-ahead.
 *
 * The reducer is pure and separate from the hook so the fiddly parts (which row does
 * shift-click extend from after a ctrl-click? does type-ahead wrap?) are unit-testable
 * without a DOM.
 */

import { useCallback, useRef } from "react";
import { useExplorerStore } from "../explorer-store";

export interface SelectionState {
  selection: Set<string>;
  /** The cursor row: shift-range extends from here and arrows move it. */
  anchor: string | null;
}

export type SelectionEvent =
  | { type: "click"; path: string; shift?: boolean; ctrl?: boolean }
  | { type: "select-all" }
  | { type: "clear" }
  | { type: "set"; paths: string[]; anchor?: string | null };

/** How long a type-ahead buffer stays alive between keystrokes. */
export const TYPE_AHEAD_RESET_MS = 800;

function rangeBetween(order: string[], from: string | null, to: string): string[] {
  const start = from == null ? -1 : order.indexOf(from);
  const end = order.indexOf(to);
  if (end < 0) return [];
  if (start < 0) return [to];
  const [lo, hi] = start <= end ? [start, end] : [end, start];
  return order.slice(lo, hi + 1);
}

/** Apply a selection event against the current visible row order. */
export function applySelection(
  state: SelectionState,
  order: string[],
  event: SelectionEvent,
): SelectionState {
  switch (event.type) {
    case "clear":
      return { selection: new Set(), anchor: null };

    case "select-all":
      return { selection: new Set(order), anchor: state.anchor ?? order[0] ?? null };

    case "set":
      return {
        selection: new Set(event.paths),
        anchor: event.anchor !== undefined ? event.anchor : (event.paths[event.paths.length - 1] ?? null),
      };

    case "click": {
      if (event.ctrl) {
        const selection = new Set(state.selection);
        if (selection.has(event.path)) selection.delete(event.path);
        else selection.add(event.path);
        // Ctrl-click moves the anchor so a following shift-click extends from the row
        // the user just touched — matching Explorer and Finder.
        return { selection, anchor: event.path };
      }
      if (event.shift) {
        const range = rangeBetween(order, state.anchor, event.path);
        // The anchor stays put: repeated shift-clicks grow and shrink one range.
        return { selection: new Set(range), anchor: state.anchor ?? event.path };
      }
      return { selection: new Set([event.path]), anchor: event.path };
    }
  }
}

/** Row the cursor moves to for an arrow key. Clamps at both ends (no wrap). */
export function moveCursor(order: string[], anchor: string | null, delta: number): string | null {
  if (order.length === 0) return null;
  const current = anchor == null ? -1 : order.indexOf(anchor);
  if (current < 0) return delta > 0 ? order[0]! : order[order.length - 1]!;
  const next = Math.min(order.length - 1, Math.max(0, current + delta));
  return order[next]!;
}

/**
 * First name matching the typed prefix, searching after the current row and wrapping.
 * Returns the index in `names`, or -1.
 */
export function typeAheadIndex(names: string[], buffer: string, currentIndex: number): number {
  if (!buffer) return -1;
  const needle = buffer.toLowerCase();
  // A repeated single character cycles through the matches instead of sticking on one.
  const start = currentIndex < 0 ? 0 : currentIndex + 1;
  for (let i = 0; i < names.length; i++) {
    const index = (start + i) % names.length;
    if (names[index]!.toLowerCase().startsWith(needle)) return index;
  }
  return -1;
}

export interface EntrySelection {
  onRowClick(path: string, event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): void;
  selectOnly(path: string): void;
  selectAll(): void;
  clear(): void;
  setSelection(paths: string[], anchor?: string | null): void;
  moveTo(delta: number, extend: boolean): void;
  /** Feed a printable key; returns the path it landed on, if any. */
  typeAhead(key: string): string | null;
}

/** Binds the reducer to one window's slice. `order` is the visible row order. */
export function useEntrySelection(windowId: string, order: string[]): EntrySelection {
  const patch = useExplorerStore((s) => s.patch);
  const orderRef = useRef(order);
  orderRef.current = order;
  const bufferRef = useRef({ text: "", at: 0 });

  const dispatch = useCallback(
    (event: SelectionEvent) => {
      const slice = useExplorerStore.getState().slices[windowId];
      if (!slice) return;
      patch(windowId, applySelection(slice, orderRef.current, event));
    },
    [windowId, patch],
  );

  const moveTo = useCallback(
    (delta: number, extend: boolean) => {
      const slice = useExplorerStore.getState().slices[windowId];
      if (!slice) return;
      const target = moveCursor(orderRef.current, slice.anchor, delta);
      if (target == null) return;
      dispatch({ type: "click", path: target, shift: extend });
    },
    [windowId, dispatch],
  );

  const typeAhead = useCallback(
    (key: string) => {
      const slice = useExplorerStore.getState().slices[windowId];
      if (!slice) return null;
      const now = Date.now();
      const buffer = now - bufferRef.current.at > TYPE_AHEAD_RESET_MS ? key : bufferRef.current.text + key;
      bufferRef.current = { text: buffer, at: now };

      const paths = orderRef.current;
      const names = paths.map((p) => p.split(/[/\\]/).pop() ?? p);
      // With a one-character buffer the search starts after the cursor so pressing the
      // same letter walks through every match.
      const from = buffer.length === 1 && slice.anchor ? paths.indexOf(slice.anchor) : -1;
      const index = typeAheadIndex(names, buffer, from);
      if (index < 0) return null;
      dispatch({ type: "click", path: paths[index]! });
      return paths[index]!;
    },
    [windowId, dispatch],
  );

  return {
    onRowClick: (path, event) =>
      dispatch({ type: "click", path, shift: event.shiftKey, ctrl: event.ctrlKey || event.metaKey }),
    selectOnly: (path) => dispatch({ type: "click", path }),
    selectAll: () => dispatch({ type: "select-all" }),
    clear: () => dispatch({ type: "clear" }),
    setSelection: (paths, anchor) => dispatch({ type: "set", paths, anchor }),
    moveTo,
    typeAhead,
  };
}
