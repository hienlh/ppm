import { useEffect, useState, useCallback } from "react";
import { useTabStore } from "@/stores/tab-store";

/**
 * Global keyboard shortcuts.
 *
 * Shift+Shift (double tap) → Open command palette
 * Alt+] / Alt+[            → Next / previous tab
 */
export function useGlobalKeybindings() {
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    let lastShiftUp = 0;

    function handler(e: KeyboardEvent) {
      // Double-Shift detection (on keyup to avoid repeats)
      if (e.type === "keyup" && e.key === "Shift" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const now = Date.now();
        if (now - lastShiftUp < 400) {
          lastShiftUp = 0;
          setPaletteOpen(true);
          return;
        }
        lastShiftUp = now;
        return;
      }

      // Keydown shortcuts
      if (e.type !== "keydown") return;

      // Alt+] / Alt+[ → Cycle tabs
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "]" || e.key === "[")) {
        e.preventDefault();
        const { tabs, activeTabId, setActiveTab } = useTabStore.getState();
        if (tabs.length < 2) return;
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        const next = e.key === "]"
          ? (idx + 1) % tabs.length
          : (idx - 1 + tabs.length) % tabs.length;
        setActiveTab(tabs[next]!.id);
      }
    }

    window.addEventListener("keydown", handler);
    window.addEventListener("keyup", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      window.removeEventListener("keyup", handler);
    };
  }, []);

  const closePalette = useCallback(() => setPaletteOpen(false), []);

  return { paletteOpen, closePalette };
}
