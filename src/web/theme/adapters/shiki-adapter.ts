import { createHighlighter, type Highlighter } from "shiki";
import type { PpmTheme } from "../types";
import { THEME_CHANGE_EVENT, getCurrentAppliedTheme } from "../apply-theme";

/**
 * Shiki syntax-highlighting singleton. Replaces highlight.js for chat code
 * blocks. Preloads the built-in themes + common languages; loads others lazily.
 */

const BUILTIN_SHIKI_THEMES = ["github-dark-dimmed", "github-light", "one-dark-pro"];

const PRELOAD_LANGS = [
  "javascript", "typescript", "tsx", "jsx", "json", "shellscript", "bash",
  "python", "go", "rust", "sql", "yaml", "markdown", "html", "css", "docker",
];

/** Common aliases → shiki language id. */
const LANG_ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  py: "python",
  rs: "rust",
  yml: "yaml",
  md: "markdown",
  dockerfile: "docker",
  golang: "go",
};

let highlighterPromise: Promise<Highlighter> | null = null;
let activeThemeName = "github-dark-dimmed";
const loadedLangs = new Set(PRELOAD_LANGS);
const loadedThemes = new Set(BUILTIN_SHIKI_THEMES);

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: BUILTIN_SHIKI_THEMES,
      langs: PRELOAD_LANGS,
    });
  }
  return highlighterPromise;
}

/** Kick off highlighter creation early (idle) so first render isn't cold. */
export function warmShiki(): void {
  void getHighlighter();
}

function normalizeLang(lang?: string): string {
  const l = (lang || "").toLowerCase().trim();
  return LANG_ALIASES[l] ?? l;
}

/**
 * Highlight code to an HTML string using the active theme. Loads the language
 * on demand; falls back to plain text for unknown languages.
 */
export async function highlightToHtml(code: string, lang?: string): Promise<string> {
  const hl = await getHighlighter();
  let resolvedLang = normalizeLang(lang);

  if (resolvedLang && !loadedLangs.has(resolvedLang)) {
    try {
      await hl.loadLanguage(resolvedLang as never);
      loadedLangs.add(resolvedLang);
    } catch {
      resolvedLang = "text";
    }
  }
  if (!resolvedLang) resolvedLang = "text";

  return hl.codeToHtml(code, { lang: resolvedLang, theme: activeThemeName });
}

export function getActiveShikiTheme(): string {
  return activeThemeName;
}

/**
 * Point the adapter at a theme. Accepts a bundled name or raw VSCode theme
 * JSON (imported themes, Phase 3). Returns the resolved theme name.
 */
async function setActiveShikiTheme(shikiTheme: string | Record<string, unknown>): Promise<void> {
  const hl = await getHighlighter();
  if (typeof shikiTheme === "string") {
    if (!loadedThemes.has(shikiTheme)) {
      try {
        await hl.loadTheme(shikiTheme as never);
        loadedThemes.add(shikiTheme);
      } catch {
        return; // keep current theme on failure
      }
    }
    activeThemeName = shikiTheme;
  } else {
    const name = (shikiTheme as { name?: string }).name;
    if (!name) return;
    if (!loadedThemes.has(name)) {
      try {
        await hl.loadTheme(shikiTheme as never);
        loadedThemes.add(name);
      } catch {
        return;
      }
    }
    activeThemeName = name;
  }
}

/** Resolve the shiki theme for a PpmTheme, defaulting by mode. */
function shikiThemeForPpm(theme: PpmTheme): string | Record<string, unknown> {
  if (theme.syntax?.shikiTheme) return theme.syntax.shikiTheme;
  return theme.mode === "light" ? "github-light" : "github-dark-dimmed";
}

let subscribed = false;

/**
 * Subscribe the adapter to theme changes. On each change, switch the active
 * shiki theme and re-emit a lightweight event so mounted code blocks re-render.
 * Idempotent — safe to call from multiple mounts.
 */
export function initShikiThemeSync(): void {
  if (subscribed || typeof window === "undefined") return;
  subscribed = true;
  const handler = (e: Event) => {
    const theme = (e as CustomEvent<PpmTheme>).detail;
    if (!theme) return;
    void setActiveShikiTheme(shikiThemeForPpm(theme)).then(() => {
      window.dispatchEvent(new CustomEvent("ppm:shiki-theme-change"));
    });
  };
  window.addEventListener(THEME_CHANGE_EVENT, handler);
  // Catch up to the theme already applied before this subscription.
  const applied = getCurrentAppliedTheme();
  if (applied) {
    void setActiveShikiTheme(shikiThemeForPpm(applied)).then(() => {
      window.dispatchEvent(new CustomEvent("ppm:shiki-theme-change"));
    });
  }
}
