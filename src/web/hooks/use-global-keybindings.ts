import { useEffect, useState, useCallback } from "react";
import { useTabStore } from "@/stores/tab-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useProjectStore } from "@/stores/project-store";
import { useKeybindingsStore } from "@/stores/keybindings-store";

/** Dispatch this event to open the command palette from anywhere, optionally with initial query */
export function openCommandPalette(initialQuery?: string) {
  window.dispatchEvent(new CustomEvent("open-command-palette", { detail: initialQuery }));
}

/**
 * Global keyboard shortcuts — reads bindings from keybindings store.
 *
 * Shift+Shift (double tap) is always hardcoded (non-customizable).
 * Everything else uses `matchesEvent()` from the keybindings store.
 */
export function useGlobalKeybindings() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteInitialQuery, setPaletteInitialQuery] = useState("");

  useEffect(() => {
    let lastShiftUp = 0;
    const { matchesEvent } = useKeybindingsStore.getState();

    function handler(e: KeyboardEvent) {
      // Double-Shift detection (on keyup to avoid repeats) — always active
      if (e.type === "keyup" && e.key === "Shift" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const now = Date.now();
        if (now - lastShiftUp < 400) {
          lastShiftUp = 0;
          setPaletteInitialQuery("");
          setPaletteOpen(true);
          return;
        }
        lastShiftUp = now;
        return;
      }

      if (e.type !== "keydown") return;

      // Re-read matchesEvent on each keydown to pick up live overrides
      const { matchesEvent: match } = useKeybindingsStore.getState();

      // Prevent browser save dialog (locked — always Mod+S)
      if (match(e, "save-prevent")) {
        e.preventDefault();
        return;
      }

      // Command palette
      if (match(e, "command-palette")) {
        e.preventDefault();
        setPaletteInitialQuery("");
        setPaletteOpen(true);
        return;
      }

      // Toggle sidebar
      if (match(e, "toggle-sidebar")) {
        e.preventDefault();
        useSettingsStore.getState().toggleSidebar();
        return;
      }

      // Tab cycling
      if (match(e, "next-tab") || match(e, "prev-tab")) {
        e.preventDefault();
        const { tabs, activeTabId, setActiveTab } = useTabStore.getState();
        if (tabs.length < 2) return;
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        const forward = match(e, "next-tab");
        const next = forward
          ? (idx + 1) % tabs.length
          : (idx - 1 + tabs.length) % tabs.length;
        setActiveTab(tabs[next]!.id);
        return;
      }

      // Open tab shortcuts
      const tabShortcuts: { action: string; type: string; title: string }[] = [
        { action: "open-chat", type: "chat", title: "AI Chat" },
        { action: "open-terminal", type: "terminal", title: "Terminal" },
        { action: "open-git-graph", type: "git-graph", title: "Git Graph" },
      ];
      for (const s of tabShortcuts) {
        if (match(e, s.action)) {
          e.preventDefault();
          const project = useProjectStore.getState().activeProject;
          useTabStore.getState().openTab({
            type: s.type as any,
            title: s.title,
            projectId: project?.name ?? null,
            metadata: project ? { projectName: project.name } : undefined,
            closable: true,
          });
          return;
        }
      }

      // Open settings (sidebar)
      if (match(e, "open-settings")) {
        e.preventDefault();
        const settings = useSettingsStore.getState();
        if (settings.sidebarCollapsed) settings.toggleSidebar();
        settings.setSidebarActiveTab("settings");
        return;
      }

      // Open git status (sidebar)
      if (match(e, "open-git-status")) {
        e.preventDefault();
        const settings = useSettingsStore.getState();
        if (settings.sidebarCollapsed) settings.toggleSidebar();
        settings.setSidebarActiveTab("git");
        return;
      }

      // Open search (sidebar)
      if (match(e, "open-search")) {
        e.preventDefault();
        const settings = useSettingsStore.getState();
        if (settings.sidebarCollapsed) settings.toggleSidebar();
        settings.setSidebarActiveTab("search");
        return;
      }

      // Switch project 1-9
      for (let i = 1; i <= 9; i++) {
        if (match(e, `switch-project-${i}`)) {
          e.preventDefault();
          const projects = useProjectStore.getState().projects;
          const target = projects[i - 1];
          if (target) {
            useProjectStore.getState().setActiveProject(target);
            useTabStore.getState().switchProject(target.name);
          }
          return;
        }
      }
    }

    // Custom event listener for programmatic opening
    function handleOpenPalette(e: Event) {
      const query = (e as CustomEvent).detail;
      setPaletteInitialQuery(typeof query === "string" ? query : "");
      setPaletteOpen(true);
    }

    window.addEventListener("keydown", handler);
    window.addEventListener("keyup", handler);
    window.addEventListener("open-command-palette", handleOpenPalette);
    return () => {
      window.removeEventListener("keydown", handler);
      window.removeEventListener("keyup", handler);
      window.removeEventListener("open-command-palette", handleOpenPalette);
    };
  }, []);

  const closePalette = useCallback(() => { setPaletteOpen(false); setPaletteInitialQuery(""); }, []);

  return { paletteOpen, paletteInitialQuery, closePalette };
}
