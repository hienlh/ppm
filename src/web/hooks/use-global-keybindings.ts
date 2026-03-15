import { useEffect } from "react";
import { useTabStore } from "@/stores/tab-store";
import { useProjectStore } from "@/stores/project-store";

/**
 * Global keyboard shortcuts — browser-style tab management.
 *
 * Cmd/Ctrl+T  → New terminal tab
 * Cmd/Ctrl+W  → Close active tab
 * Ctrl+Tab    → Next tab
 * Ctrl+Shift+Tab → Previous tab
 */
export function useGlobalKeybindings() {
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      // Ignore when typing in inputs/textareas (except for tab switching)
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable;

      switch (e.key.toLowerCase()) {
        // Cmd/Ctrl+T → New terminal tab
        case "t": {
          if (e.shiftKey || e.altKey) return;
          e.preventDefault();
          const activeProject = useProjectStore.getState().activeProject;
          useTabStore.getState().openTab({
            type: "terminal",
            title: "Terminal",
            projectId: activeProject?.name ?? null,
            metadata: { projectName: activeProject?.name },
            closable: true,
          });
          break;
        }

        // Cmd/Ctrl+W → Close active tab
        case "w": {
          if (e.shiftKey || e.altKey) return;
          e.preventDefault();
          const { activeTabId, tabs, closeTab } = useTabStore.getState();
          if (!activeTabId) return;
          const active = tabs.find((t) => t.id === activeTabId);
          if (active?.closable) closeTab(activeTabId);
          break;
        }

        // Ctrl+Tab / Ctrl+Shift+Tab → Cycle tabs
        case "tab": {
          if (!e.ctrlKey) return; // only Ctrl+Tab, not Cmd+Tab (OS-level)
          if (isInput) return;
          e.preventDefault();
          const { tabs, activeTabId, setActiveTab } = useTabStore.getState();
          if (tabs.length < 2) return;
          const idx = tabs.findIndex((t) => t.id === activeTabId);
          const next = e.shiftKey
            ? (idx - 1 + tabs.length) % tabs.length
            : (idx + 1) % tabs.length;
          setActiveTab(tabs[next]!.id);
          break;
        }
      }
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
