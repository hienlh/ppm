import { isMinimalTab } from "@/lib/minimal-mode";
import { useEffect, useState, useCallback } from "react";
import { useTabStore } from "@/stores/tab-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useProjectStore } from "@/stores/project-store";
import { usePanelStore } from "@/stores/panel-store";
import { useKeybindingsStore, parseCombo, eventMatchesCombo, matchesDockBacktick } from "@/stores/keybindings-store";
import { isMobileDevice } from "@/hooks/use-is-mobile";
import { useExtensionStore } from "@/stores/extension-store";
import { useCompareStore } from "@/stores/compare-store";
import { openSettings } from "@/components/settings/open-settings";
import { basename } from "@/lib/utils";
import { dispatchExtCommand } from "@/lib/ext-command-dispatch";
import { getFocusedSelection } from "@/lib/open-editors-registry";
import { nextMatch } from "@/lib/search/search-rows";
import { searchClient } from "@/lib/search/search-client";
import { getSearchState, useSearchStore } from "@/stores/search-store";

/** Dispatch this event to open the command palette from anywhere, optionally with initial query */
export function openCommandPalette(initialQuery?: string) {
  window.dispatchEvent(new CustomEvent("open-command-palette", { detail: initialQuery }));
}

/**
 * The search shortcut: show the Search panel, and when the focused editor of the active project
 * has text selected on one line, search for that text (6.4) — VS Code's seeding.
 */
function openSearchPanel() {
  const settings = useSettingsStore.getState();
  if (settings.sidebarCollapsed) settings.toggleSidebar();
  settings.setSidebarActiveTab("search");
  const project = useProjectStore.getState().activeProject?.name;
  const selection = getFocusedSelection();
  if (!project || !selection?.singleLine || selection.projectName !== project) return;
  if (getSearchState(project).query === selection.text) return;
  useSearchStore.getState().update(project, { query: selection.text });
  searchClient.schedule(project);
}

/**
 * F4 (`dir` 1) / Shift+F4 (`dir` -1): open the match after / before the focused one in the
 * active project's results, wrapping, with the matched text selected (6.2). False when there
 * is no match to open, so the key stays free for anything else bound to it.
 */
function openAdjacentSearchMatch(dir: 1 | -1): boolean {
  const project = useProjectStore.getState().activeProject?.name;
  if (!project) return false;
  const state = getSearchState(project);
  const viewMode = useSearchStore.getState().viewMode;
  const target = nextMatch(state.response, { viewMode, dismissed: state.dismissed }, state.focusedRow, dir);
  if (!target) return false;
  useSearchStore.getState().update(project, { focusedRow: target.key });
  const { file, match } = target;
  // Match columns are 0-based; the editor's selection is 1-based, end exclusive (as Monaco counts).
  const column = match.column + 1;
  const metadata = {
    filePath: file,
    projectName: project,
    lineNumber: match.line,
    selection: { line: match.line, column, endColumn: column + match.length },
    revealAt: Date.now(),
  };
  const id = useTabStore.getState().openTab({ type: "editor", title: basename(file), projectId: project, metadata, closable: true });
  // A tab already open on this file is deduped and keeps its old metadata, so push the new
  // target onto it for the editor's reveal effect to fire (as the command palette does).
  if (id) useTabStore.getState().updateTab(id, { metadata });
  return true;
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
    /** Cache parsed combos for extension keybindings (combo string → ParsedCombo) */
    const extParsedCache = new Map<string, ReturnType<typeof parseCombo>>();

    let composing = false;
    function onCompositionStart() { composing = true; }
    function onCompositionEnd() { composing = false; }

    /** Chat transcript jumps. Returns true when the event was consumed. */
    function dispatchChatNav(e: KeyboardEvent, m: (ev: KeyboardEvent, id: string) => boolean) {
      const dir = m(e, "chat-nav-prev") ? "prev" : m(e, "chat-nav-next") ? "next" : null;
      if (!dir) return false;
      e.preventDefault();
      window.dispatchEvent(new CustomEvent(`chat-nav-${dir}`));
      return true;
    }

    /**
     * The search shortcut and F4 / Shift+F4. They fire inside text fields too: the editor is a
     * textarea, and it is where the selection to search for is made and where F4 is pressed
     * from. Returns true when the event was consumed.
     */
    function dispatchSearchKeys(e: KeyboardEvent, m: (ev: KeyboardEvent, id: string) => boolean) {
      if (m(e, "open-search")) {
        e.preventDefault();
        openSearchPanel();
        return true;
      }
      const dir = m(e, "search-next-match") ? 1 : m(e, "search-prev-match") ? -1 : 0;
      if (!dir || !openAdjacentSearchMatch(dir)) return false;
      e.preventDefault();
      return true;
    }

    /** Mod+1..9: the project at that place in the list. Returns true when the event was consumed. */
    function dispatchSwitchProject(e: KeyboardEvent, m: (ev: KeyboardEvent, id: string) => boolean) {
      for (let i = 1; i <= 9; i++) {
        if (!m(e, `switch-project-${i}`)) continue;
        e.preventDefault();
        const target = useProjectStore.getState().projects[i - 1];
        if (target) {
          useProjectStore.getState().setActiveProject(target);
          useTabStore.getState().switchProject(target.name);
        }
        return true;
      }
      return false;
    }

    function handler(e: KeyboardEvent) {
      if (useSettingsStore.getState().minimalMode) {
        if (e.type !== "keydown" || composing || e.isComposing) return;
        const { matchesEvent: match } = useKeybindingsStore.getState();
        if (dispatchChatNav(e, match)) return;
        if (match(e, "save-prevent")) e.preventDefault();
        // Like full mode below: inside a text field only the locked shortcuts fire.
        const target = e.target as HTMLElement | null;
        if (target?.tagName === "TEXTAREA" || target?.tagName === "INPUT" || target?.isContentEditable) return;
        if (match(e, "toggle-sidebar")) {
          e.preventDefault();
          useSettingsStore.getState().toggleSidebar();
        } else if (match(e, "new-file")) {
          e.preventDefault();
          useTabStore.getState().openNewFile();
        } else if (match(e, "open-settings")) {
          e.preventDefault();
          openSettings();
        } else if (match(e, "open-chat")) {
          e.preventDefault();
          const project = useProjectStore.getState().activeProject;
          useTabStore.getState().openTab({ type: "chat", title: "AI Chat", projectId: project?.name ?? null,
            metadata: project ? { projectName: project.name } : undefined, closable: true });
        } else if (match(e, "voice-input")) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("toggle-voice-input"));
        } else if (match(e, "open-search")) {
          e.preventDefault();
          const settings = useSettingsStore.getState();
          if (settings.sidebarCollapsed) settings.toggleSidebar();
          settings.setSidebarActiveTab("search");
        } else if (match(e, "next-tab") || match(e, "prev-tab")) {
          e.preventDefault();
          const state = useTabStore.getState();
          const chats = state.tabs.filter((tab) => isMinimalTab(tab.type));
          if (!chats.length) return;
          const index = chats.findIndex((tab) => tab.id === state.activeTabId);
          const next = (index + (match(e, "next-tab") ? 1 : -1) + chats.length) % chats.length;
          state.setActiveTab(chats[next]!.id);
        } else {
          dispatchSwitchProject(e, match);
        }
        return;
      }
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

      // When focus is inside a text input, skip most keybinding checks to
      // avoid lag on every keystroke (Shift+arrows, Ctrl+A, Ctrl+C, etc.).
      // Only "locked" shortcuts that override browser defaults still fire.
      const tag = (e.target as HTMLElement)?.tagName;
      const isTextInput = tag === "TEXTAREA" || tag === "INPUT" || (e.target as HTMLElement)?.isContentEditable;
      if (isTextInput) {
        const { matchesEvent: m } = useKeybindingsStore.getState();
        // Mod+S — always prevent browser save dialog
        if (m(e, "save-prevent")) { e.preventDefault(); }
        // toggle-dock (Mod+', and VS Code's Ctrl+` on desktop) fires even when the
        // terminal textarea is focused (VSCode parity). Both are modifier combos, so
        // neither can produce a plain quote or backtick in the shell.
        if (m(e, "toggle-dock") || matchesDockBacktick(e, isMobileDevice())) {
          e.preventDefault();
          usePanelStore.getState().toggleDock();
        }
        if (dispatchSearchKeys(e, m)) return;
        // The composer holds focus for most of a chat session, so the transcript
        // jumps have to survive this early return or they are unreachable.
        dispatchChatNav(e, m);
        return;
      }

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

      // Toggle terminal dock
      if (match(e, "toggle-dock") || matchesDockBacktick(e, isMobileDevice())) {
        e.preventDefault();
        usePanelStore.getState().toggleDock();
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

      // Open settings — its own window on desktop, a tab on mobile.
      if (match(e, "open-settings")) {
        e.preventDefault();
        openSettings();
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

      // Chat transcript navigation — the focused panel's chat tab picks these up
      if (dispatchChatNav(e, match)) return;

      // Compare Files — seed A from active editor tab if applicable, then open picker
      if (match(e, "compare-files")) {
        e.preventDefault();
        const { activeTabId, tabs } = useTabStore.getState();
        const active = tabs.find((t) => t.id === activeTabId);
        const meta = active?.metadata as { filePath?: string; projectName?: string; unsavedContent?: string } | undefined;
        if (active?.type === "editor" && meta?.filePath && meta?.projectName) {
          useCompareStore.getState().setSelection({
            filePath: meta.filePath,
            projectName: meta.projectName,
            dirtyContent: meta.unsavedContent,
            label: basename(meta.filePath),
          });
        }
        window.dispatchEvent(new CustomEvent("open-compare-picker"));
        return;
      }

      // Open search (sidebar), and F4 / Shift+F4 through its results
      if (dispatchSearchKeys(e, match)) return;

      // Problems, in the dock — VS Code's Ctrl+Shift+M, and its placement.
      if (match(e, "open-problems")) {
        e.preventDefault();
        usePanelStore.getState().openInDock({
          type: "problems", title: "Problems", projectId: null, closable: true,
        });
        return;
      }

      if (dispatchSwitchProject(e, match)) return;

      // Extension-contributed keybindings (with user override support)
      const extKbs = useExtensionStore.getState().contributions?.keybindings;
      if (extKbs) {
        const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
        const { getBinding: getBind } = useKeybindingsStore.getState();
        for (const kb of extKbs) {
          const overrideCombo = getBind(`ext:${kb.command}`);
          const raw = overrideCombo || ((mac && kb.mac) ? kb.mac : kb.key);
          if (!raw) continue;
          // Use per-extension parsed cache to avoid parseCombo on every keydown
          let parsed = extParsedCache.get(raw);
          if (!parsed) { parsed = parseCombo(raw); extParsedCache.set(raw, parsed); }
          if (eventMatchesCombo(e, parsed)) {
            e.preventDefault();
            void dispatchExtCommand(kb.command);
            return;
          }
        }
      }
    }

    // Custom event listener for programmatic opening
    function handleOpenPalette(e: Event) {
      if (useSettingsStore.getState().minimalMode) return;
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
