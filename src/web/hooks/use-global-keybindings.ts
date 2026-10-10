import { useEffect, useState, useCallback } from "react";
import { useTabStore } from "@/stores/tab-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useProjectStore } from "@/stores/project-store";
import { usePanelStore } from "@/stores/panel-store";
import { useKeybindingsStore, parseCombo, eventMatchesCombo, matchesDockBacktick } from "@/stores/keybindings-store";
import { isMobileDevice } from "@/hooks/use-is-mobile";
import { useExtensionStore } from "@/stores/extension-store";
import { listCommands, runCommandInBackground } from "@/lib/commands/command-registry";
import { readCommandContext } from "@/lib/commands/read-command-context";
import { extensionKeyCombo, runExtensionCommand } from "@/lib/commands/extension-commands";

/**
 * The keybinding actions that run a command-registry command (the command declaring that
 * `binding`), in the order they are checked — which decides who wins when a user binds one
 * combo to two of them. The registry holds what each one does, so a shortcut and its palette
 * row cannot drift apart.
 */
const COMMAND_BINDINGS_FIRST = ["new-file", "open-chat", "open-terminal", "open-settings", "open-assistant", "open-git-status", "voice-input"];
const COMMAND_BINDINGS_COMPARE = ["compare-files"];
const COMMAND_BINDINGS_LAST = ["open-problems"];

/**
 * Runs the registry command bound to whichever of `bindings` the event matches. True when the
 * event was consumed.
 */
function runBoundCommand(e: KeyboardEvent, match: (ev: KeyboardEvent, id: string) => boolean, bindings: readonly string[]): boolean {
  const binding = bindings.find((id) => match(e, id));
  if (!binding) return false;
  const ctx = readCommandContext();
  const cmd = listCommands(ctx).find((c) => c.binding === binding);
  if (!cmd) return false;
  e.preventDefault();
  runCommandInBackground(cmd, ctx);
  return true;
}

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

      // New file, new chat or terminal, Settings, the Assistant, Source Control, voice input
      if (runBoundCommand(e, match, COMMAND_BINDINGS_FIRST)) return;

      // Chat transcript navigation — the focused panel's chat tab picks these up
      if (dispatchChatNav(e, match)) return;

      // Compare Files — seeded from the editor in front
      if (runBoundCommand(e, match, COMMAND_BINDINGS_COMPARE)) return;

      // Open search (sidebar)
      if (match(e, "open-search")) {
        e.preventDefault();
        const settings = useSettingsStore.getState();
        if (settings.sidebarCollapsed) settings.toggleSidebar();
        settings.setSidebarActiveTab("search");
        return;
      }

      // Problems, in the dock — VS Code's Ctrl+Shift+M, and its placement.
      if (runBoundCommand(e, match, COMMAND_BINDINGS_LAST)) return;

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
        const keybindings = useKeybindingsStore.getState();
        for (const kb of extKbs) {
          const raw = extensionKeyCombo(keybindings, kb);
          if (!raw) continue;
          // Use per-extension parsed cache to avoid parseCombo on every keydown
          let parsed = extParsedCache.get(raw);
          if (!parsed) { parsed = parseCombo(raw); extParsedCache.set(raw, parsed); }
          if (eventMatchesCombo(e, parsed)) {
            e.preventDefault();
            void runExtensionCommand(kb.command).catch((err) => console.error(`[keybindings] "${kb.command}" failed:`, err));
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
