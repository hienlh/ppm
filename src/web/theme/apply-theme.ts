import type { PpmTheme, PpmThemeTokens } from "./types";
import { TOKEN_KEYS, tokenToCssVar } from "./tokens";

/** Event fired after a theme is applied. Surface adapters (Phase 2) listen for this. */
export const THEME_CHANGE_EVENT = "ppm:theme-change";

let currentTheme: PpmTheme | null = null;

/** The most recently applied theme (for adapters initializing after first paint). */
export function getCurrentAppliedTheme(): PpmTheme | null {
  return currentTheme;
}

const MOBILE_QUERY = "(max-width: 767px)";

function isMobileViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches;
}

/** Resolve the effective token set, applying mobile overrides on small viewports. */
function effectiveTokens(theme: PpmTheme): PpmThemeTokens {
  if (isMobileViewport() && theme.mobileOverrides) {
    return { ...theme.tokens, ...theme.mobileOverrides };
  }
  return theme.tokens;
}

/**
 * Write a theme's tokens to CSS vars on `<html>`, update meta theme-color,
 * toggle the dark/light class, and dispatch the theme-change event.
 */
export function applyTheme(theme: PpmTheme): void {
  currentTheme = theme;
  const root = document.documentElement;
  const tokens = effectiveTokens(theme);

  for (const key of TOKEN_KEYS) {
    root.style.setProperty(tokenToCssVar(key), tokens[key]);
  }

  root.classList.toggle("dark", theme.mode === "dark");
  root.classList.toggle("light", theme.mode === "light");

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", tokens.bgSolid);

  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: theme }));
}
