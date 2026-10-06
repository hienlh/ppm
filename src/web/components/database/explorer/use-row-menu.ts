/**
 * One context menu for a whole tree, resolved from the row the gesture landed on, as the file
 * tree does it. A mouse opens it on `contextmenu`; a finger fires `pointerdown` well before the
 * long-press timer runs out. A row with no menu — a divider, a "loading" line, the empty space
 * below the rows — opens none at all.
 */
import { useState, type SyntheticEvent } from "react";

export function useRowMenu<E>(menuFor: (key: string | null) => E | null, setCursor: (key: string) => void): {
  /** The menu for the row it last opened on. Not cleared on close: it would swap to nothing during its exit animation. */
  entries: E | null;
  /**
   * Spread on the list inside the menu's trigger. `touchstart` is stopped on a row with no menu,
   * so the adaptive menu's long-press — which is what handles `touchcancel` — never arms there.
   */
  listProps: {
    onContextMenuCapture: (e: SyntheticEvent) => void;
    onPointerDownCapture: (e: SyntheticEvent) => void;
    onTouchStartCapture: (e: SyntheticEvent) => void;
  };
} {
  const [menuKey, setMenuKey] = useState<string | null>(null);

  const remember = (e: SyntheticEvent) => {
    if (e.type === "pointerdown" && (e.nativeEvent as PointerEvent).pointerType === "mouse") return;
    const key = (e.target as HTMLElement | null)?.closest?.<HTMLElement>("[data-row-key]")?.dataset.rowKey ?? null;
    if (!menuFor(key)) {
      if (e.type === "contextmenu") e.preventDefault();
      if (e.type === "touchstart") e.stopPropagation();
      return;
    }
    setMenuKey((prev) => (prev === key ? prev : key));
    if (e.type === "contextmenu" && key) setCursor(key);
  };

  return { entries: menuFor(menuKey), listProps: { onContextMenuCapture: remember, onPointerDownCapture: remember, onTouchStartCapture: remember } };
}
