import type { PpmTheme, PpmThemeMode, PpmThemeStyle } from "./types";
import { BUILTIN_THEMES, DEFAULT_THEME } from "./builtin";

/** Query the OS color scheme (used for `mode: "system"`). */
export function osPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * Resolve a `{style, mode}` selection into a concrete PpmTheme.
 *
 * - `mode: "system"` picks dark/light from the OS.
 * - `style: "custom"` looks up an imported theme by id (Phase 3); imported
 *   themes are single-mode and fill both slots, so mode is ignored for them.
 * - Falls back to Aurora Dark if the selection can't be resolved.
 */
export function resolveTheme(
  style: PpmThemeStyle,
  mode: PpmThemeMode,
  customThemes: PpmTheme[] = [],
  customId?: string,
): PpmTheme {
  if (style === "custom") {
    const found = customThemes.find((t) => t.id === customId);
    return found ?? DEFAULT_THEME;
  }

  const concreteMode: "dark" | "light" = mode === "system" ? (osPrefersDark() ? "dark" : "light") : mode;
  return BUILTIN_THEMES[`${style}-${concreteMode}`] ?? DEFAULT_THEME;
}
