import type { TabType } from "@/stores/tab-store";

/** Tabs available in the reduced workspace; all other saved tabs stay untouched. */
export function isMinimalTab(type: TabType): boolean {
  return type === "chat" || type === "settings" || type === "editor";
}

const MINIMAL_KEY_ACTIONS = new Set([
  "save-prevent", "toggle-sidebar", "new-file", "open-settings", "open-chat", "voice-input",
  "open-search", "next-tab", "prev-tab", "chat-nav-prev", "chat-nav-next",
]);

/**
 * The shortcuts `useGlobalKeybindings` answers in minimal mode, which are all Settings lists
 * there: the others open what the mode hides (the palette, the terminal, Git, Problems, and the
 * compare view, a diff tab).
 */
export function isMinimalKeyAction(id: string): boolean {
  return MINIMAL_KEY_ACTIONS.has(id) || /^switch-project-[1-9]$/.test(id);
}
