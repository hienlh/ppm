/**
 * Keyboard for the Database sidebar's two trees, the way a tree view reads with the keyboard:
 * the list holds focus and a cursor row (`aria-activedescendant`) moves with the arrows. Up and
 * Down step through the rows, Right opens a row or steps into it, Left closes it or steps out to
 * its parent, Home and End jump, Enter does what a double-click does, Space what a click does,
 * and the context-menu key (or Shift+F10) opens the row's menu where the row is.
 */
import { useEffect, type KeyboardEvent, type RefObject } from "react";

export interface TreeKeysOptions<R extends { key: string }> {
  rows: readonly R[];
  cursor: string | null;
  setCursor: (key: string) => void;
  listRef: RefObject<HTMLElement | null>;
  /** Rows the cursor can stop on: not a divider or a "loading" line. */
  focusable: (row: R) => boolean;
  depthOf: (row: R) => number;
  /** Right on a closed row: open it and answer true. False steps into its first child, if it has one. */
  expand: (row: R) => boolean;
  /** Left on an open row: close it and answer true. False steps out to its parent. */
  collapse: (row: R) => boolean;
  onEnter: (row: R) => void;
  onSpace: (row: R) => void;
}

/** The id a row's element carries, for `aria-activedescendant`: row keys can hold spaces. */
export function treeRowDomId(prefix: string, key: string): string {
  return `${prefix}-${encodeURIComponent(key)}`;
}

/** The element of the row `key` in `list`, found by its `data-row-key`. */
export function treeRowElement(list: HTMLElement | null, key: string): HTMLElement | null {
  if (!list) return null;
  for (const el of list.querySelectorAll<HTMLElement>("[data-row-key]")) if (el.dataset.rowKey === key) return el;
  return null;
}

export function useTreeKeys<R extends { key: string }>(o: TreeKeysOptions<R>): (e: KeyboardEvent) => void {
  const { rows, cursor, setCursor, listRef, focusable } = o;

  // The cursor stays on screen as it moves.
  useEffect(() => {
    if (cursor !== null) treeRowElement(listRef.current, cursor)?.scrollIntoView?.({ block: "nearest" });
  }, [cursor, listRef]);

  return (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return; // an input inside the list (a folder being named) keeps its keys
    const index = rows.findIndex((r) => r.key === cursor);
    const row = index >= 0 ? rows[index] : undefined;
    const step = (from: number, dir: 1 | -1): number => {
      for (let i = from + dir; i >= 0 && i < rows.length; i += dir) if (focusable(rows[i]!)) return i;
      return -1;
    };
    const go = (i: number) => { if (i >= 0) setCursor(rows[i]!.key); };
    const openMenu = () => {
      const el = cursor ? treeRowElement(listRef.current, cursor) : null;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, button: 2,
        clientX: Math.round(rect.left + 24), clientY: Math.round(rect.top + rect.height / 2),
      }));
    };

    switch (e.key) {
      case "ArrowDown": go(step(index, 1)); break;
      case "ArrowUp": go(index < 0 ? step(rows.length, -1) : step(index, -1)); break;
      case "Home": go(step(-1, 1)); break;
      case "End": go(step(rows.length, -1)); break;
      case "ArrowRight": {
        if (!row || o.expand(row)) break;
        const next = step(index, 1);
        if (next >= 0 && o.depthOf(rows[next]!) > o.depthOf(row)) go(next);
        break;
      }
      case "ArrowLeft": {
        if (!row || o.collapse(row)) break;
        const depth = o.depthOf(row);
        for (let i = index - 1; i >= 0; i--) {
          if (focusable(rows[i]!) && o.depthOf(rows[i]!) < depth) { go(i); break; }
        }
        break;
      }
      case "Enter": if (row) o.onEnter(row); break;
      case " ": if (row) o.onSpace(row); break;
      case "ContextMenu": openMenu(); break;
      case "F10": if (e.shiftKey) { openMenu(); break; } return;
      default: return;
    }
    e.preventDefault();
  };
}
