import { create } from "zustand";
import { api } from "@/lib/api-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KeyCategory = "general" | "tabs" | "projects";

export interface KeyAction {
  id: string;
  label: string;
  category: KeyCategory;
  defaultKey: string;
  locked?: boolean;
  note?: string;
}

// ---------------------------------------------------------------------------
// Action catalog
// ---------------------------------------------------------------------------

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

export const KEY_ACTIONS: KeyAction[] = [
  // General
  { id: "command-palette", label: "Command Palette", category: "general", defaultKey: "F1", note: "Shift+Shift also opens (not customizable)" },
  { id: "toggle-sidebar", label: "Toggle Sidebar", category: "general", defaultKey: "Mod+B" },
  { id: "save-prevent", label: "Prevent Save Dialog", category: "general", defaultKey: "Mod+S", locked: true, note: "Always active — prevents browser save" },
  // Tabs
  { id: "next-tab", label: "Next Tab", category: "tabs", defaultKey: "Alt+]" },
  { id: "prev-tab", label: "Previous Tab", category: "tabs", defaultKey: "Alt+[" },
  { id: "open-chat", label: "Open Chat", category: "tabs", defaultKey: "Mod+Shift+L" },
  { id: "open-terminal", label: "Open Terminal", category: "tabs", defaultKey: "Mod+`" },
  { id: "open-settings", label: "Open Settings", category: "tabs", defaultKey: "Mod+," },
  { id: "open-git-graph", label: "Git Graph", category: "tabs", defaultKey: "Mod+Shift+G" },
  { id: "open-git-status", label: "Git Status (sidebar)", category: "tabs", defaultKey: "Mod+Shift+E" },
  { id: "open-search", label: "Search Files (sidebar)", category: "tabs", defaultKey: "Mod+Shift+F" },
  // Projects — Mod+1..9
  ...Array.from({ length: 9 }, (_, i) => ({
    id: `switch-project-${i + 1}`,
    label: `Switch to Project ${i + 1}`,
    category: "projects" as KeyCategory,
    defaultKey: `Mod+${i + 1}`,
  })),
];

/** Map action ID → default key for fast lookup */
const DEFAULT_MAP = new Map(KEY_ACTIONS.map((a) => [a.id, a.defaultKey]));

// ---------------------------------------------------------------------------
// Key combo parsing & matching
// ---------------------------------------------------------------------------

interface ParsedCombo {
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  key: string; // lowercase
}

function parseCombo(combo: string): ParsedCombo {
  const parts = combo.split("+");
  const result: ParsedCombo = { ctrl: false, meta: false, alt: false, shift: false, key: "" };
  for (const part of parts) {
    const p = part.trim();
    switch (p) {
      case "Mod":
        if (isMac) result.meta = true;
        else result.ctrl = true;
        break;
      case "Ctrl": result.ctrl = true; break;
      case "Meta": case "Cmd": result.meta = true; break;
      case "Alt": result.alt = true; break;
      case "Shift": result.shift = true; break;
      default: result.key = p.toLowerCase(); break;
    }
  }
  return result;
}

function eventMatchesCombo(e: KeyboardEvent, combo: ParsedCombo): boolean {
  if (e.ctrlKey !== combo.ctrl) return false;
  if (e.metaKey !== combo.meta) return false;
  if (e.altKey !== combo.alt) return false;
  if (e.shiftKey !== combo.shift) return false;
  return e.key.toLowerCase() === combo.key;
}

// ---------------------------------------------------------------------------
// Format combo for display
// ---------------------------------------------------------------------------

export function formatCombo(combo: string): string {
  return combo
    .replace(/Mod/g, isMac ? "\u2318" : "Ctrl")
    .replace(/Shift/g, isMac ? "\u21E7" : "Shift")
    .replace(/Alt/g, isMac ? "\u2325" : "Alt")
    .replace(/Meta|Cmd/g, "\u2318")
    .replace(/Ctrl/g, isMac ? "\u2303" : "Ctrl");
}

/** Build combo string from a KeyboardEvent (for recording) */
export function comboFromEvent(e: KeyboardEvent): string | null {
  // Ignore bare modifier keys
  if (["Control", "Meta", "Alt", "Shift"].includes(e.key)) return null;

  const parts: string[] = [];
  if (e.ctrlKey && !e.metaKey) parts.push(isMac ? "Ctrl" : "Mod");
  if (e.metaKey) parts.push(isMac ? "Mod" : "Meta");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  // Normalize key
  let key = e.key;
  if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  parts.push(key);

  return parts.join("+");
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface KeybindingsState {
  /** User overrides from server (action ID → combo string) */
  overrides: Record<string, string>;
  loaded: boolean;

  /** Get the effective binding for an action */
  getBinding: (actionId: string) => string;
  /** Check if a keyboard event matches an action */
  matchesEvent: (e: KeyboardEvent, actionId: string) => boolean;
  /** Set a custom binding (persists to server) */
  setBinding: (actionId: string, combo: string) => void;
  /** Reset a single binding to default (persists to server) */
  resetBinding: (actionId: string) => void;
  /** Reset all bindings to defaults (persists to server) */
  resetAll: () => void;
  /** Load overrides from server */
  loadFromServer: () => Promise<void>;
}

export const useKeybindingsStore = create<KeybindingsState>((set, get) => ({
  overrides: {},
  loaded: false,

  getBinding: (actionId) => {
    return get().overrides[actionId] ?? DEFAULT_MAP.get(actionId) ?? "";
  },

  matchesEvent: (e, actionId) => {
    const combo = get().getBinding(actionId);
    if (!combo) return false;
    return eventMatchesCombo(e, parseCombo(combo));
  },

  setBinding: (actionId, combo) => {
    const newOverrides = { ...get().overrides, [actionId]: combo };
    set({ overrides: newOverrides });
    // Persist to server (fire-and-forget)
    api.put("/api/settings/keybindings", { [actionId]: combo }).catch(() => {});
  },

  resetBinding: (actionId) => {
    const newOverrides = { ...get().overrides };
    delete newOverrides[actionId];
    set({ overrides: newOverrides });
    api.put("/api/settings/keybindings", { [actionId]: null }).catch(() => {});
  },

  resetAll: () => {
    set({ overrides: {} });
    // Send all current override keys as null to clear them
    const nulled: Record<string, null> = {};
    for (const key of Object.keys(get().overrides)) nulled[key] = null;
    if (Object.keys(nulled).length > 0) {
      api.put("/api/settings/keybindings", nulled).catch(() => {});
    }
  },

  loadFromServer: async () => {
    try {
      const overrides = await api.get<Record<string, string>>("/api/settings/keybindings");
      set({ overrides, loaded: true });
    } catch {
      set({ loaded: true }); // proceed with defaults on error
    }
  },
}));
