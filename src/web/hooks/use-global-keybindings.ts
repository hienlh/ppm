import { useEffect, useState, useCallback } from "react";
import { useTabStore } from "@/stores/tab-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useProjectStore } from "@/stores/project-store";
import { useKeybindingsStore, parseCombo, eventMatchesCombo } from "@/stores/keybindings-store";
import { useExtensionStore } from "@/stores/extension-store";

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
    let shiftAlone = false; // true if Shift was pressed without any other key
    const { matchesEvent } = useKeybindingsStore.getState();

    let composing = false;
    function onCompositionStart() { composing = true; }
    function onCompositionEnd() { composing = false; }

    function handler(e: KeyboardEvent) {
      // Track whether Shift is pressed alone (not as a modifier for another key)
      if (e.type === "keydown" && e.key === "Shift") {
        shiftAlone = true;
        return;
      }
      // Any non-Shift keydown while Shift is held means Shift is used as modifier
      if (e.type === "keydown" && e.shiftKey) {
        shiftAlone = false;
      }
      // Any non-Shift key resets the double-tap timer (user is typing, not double-tapping)
      if (e.type === "keydown" && e.key !== "Shift") {
        lastShiftUp = 0;
      }

      // Double-Shift detection (on keyup to avoid repeats) — always active
      // Only counts if Shift was pressed alone (not used as modifier e.g. Shift+T for uppercase)
      // Also skip during IME composition (e.g. Vietnamese Telex) to prevent false triggers
      if (e.type === "keyup" && e.key === "Shift" && shiftAlone && !e.ctrlKey && !e.metaKey && !e.altKey && !composing && !e.isComposing) {
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

      // Skip all shortcuts during IME composition
      if (composing || e.isComposing) return;

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

      // New file
      if (match(e, "new-file")) {
        e.preventDefault();
        useTabStore.getState().openNewFile();
        return;
      }

      // Open tab shortcuts
      const tabShortcuts: { action: string; type: string; title: string }[] = [
        { action: "open-chat", type: "chat", title: "AI Chat" },
        { action: "open-terminal", type: "terminal", title: "Terminal" },
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

      // Toggle voice input in chat
      if (match(e, "voice-input")) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("toggle-voice-input"));
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

      // Extension-contributed keybindings (with user override support)
      const extKbs = useExtensionStore.getState().contributions?.keybindings;
      if (extKbs) {
        const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
        const { getBinding: getBind } = useKeybindingsStore.getState();
        for (const kb of extKbs) {
          // User override via "ext:<command>" key, fallback to extension default
          const overrideCombo = getBind(`ext:${kb.command}`);
          const combo = overrideCombo || ((mac && kb.mac) ? kb.mac : kb.key);
          if (combo && eventMatchesCombo(e, parseCombo(combo))) {
            e.preventDefault();
            const project = useProjectStore.getState().activeProject;
            const args: unknown[] = [];
            if (project?.path) args.push(project.path);
            window.dispatchEvent(new CustomEvent("ext:command:execute", {
              detail: { command: kb.command, args },
            }));
            return;
          }
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
    window.addEventListener("compositionstart", onCompositionStart);
    window.addEventListener("compositionend", onCompositionEnd);
    window.addEventListener("open-command-palette", handleOpenPalette);
    return () => {
      window.removeEventListener("keydown", handler);
      window.removeEventListener("keyup", handler);
      window.removeEventListener("compositionstart", onCompositionStart);
      window.removeEventListener("compositionend", onCompositionEnd);
      window.removeEventListener("open-command-palette", handleOpenPalette);
    };
  }, []);

  const closePalette = useCallback(() => { setPaletteOpen(false); setPaletteInitialQuery(""); }, []);

  return { paletteOpen, paletteInitialQuery, closePalette };
}
