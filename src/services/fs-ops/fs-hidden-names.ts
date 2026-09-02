/**
 * Hidden-entry rules shared by browse and stat. POSIX hides dot-names; on
 * Windows the dot convention barely exists, so the shell-managed system
 * entries a user never wants to see are named explicitly.
 */
const WINDOWS_HIDDEN_NAMES = new Set([
  "desktop.ini",
  "$recycle.bin",
  "system volume information",
  "thumbs.db",
]);

export function isHiddenName(name: string): boolean {
  if (name.startsWith(".")) return true;
  if (process.platform !== "win32") return false;
  return WINDOWS_HIDDEN_NAMES.has(name.toLowerCase());
}
