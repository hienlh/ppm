/** Whether this device labels its modifier keys the Mac way (⌘, ⌥, ⇧, ⌃). */
export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

/** A keybinding combo as the palette shows it ("Mod+G" → "⌘G" on a Mac, "Ctrl+G" elsewhere). */
export function formatShortcut(combo: string): string {
  if (!combo) return "";
  return combo
    .replace(/Mod\+/g, isMac ? "⌘" : "Ctrl+")
    .replace(/Alt\+/g, isMac ? "⌥" : "Alt+")
    .replace(/Shift\+/g, isMac ? "⇧" : "Shift+")
    .replace(/Meta\+/g, "⌘")
    .replace(/Ctrl\+/g, isMac ? "⌃" : "Ctrl+");
}
