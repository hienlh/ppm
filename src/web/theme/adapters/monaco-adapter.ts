import { loader } from "@monaco-editor/react";
import type { PpmTheme } from "../types";
import { THEME_CHANGE_EVENT, getCurrentAppliedTheme } from "../apply-theme";
import { resolveTheme } from "../resolve-theme";
import { useSettingsStore } from "@/stores/settings-store";

/**
 * Monaco theming driven by PpmTheme. Monaco rejects `rgba()` color strings, so
 * only hex/hex-alpha tokens are used for workbench colors; syntax colors come
 * from the inherited vs / vs-dark base (or the theme's explicit editor rules).
 */

export function monacoThemeName(theme: PpmTheme): string {
  return `ppm-${theme.id}`;
}

/** Append an alpha byte to a #RRGGBB hex; passes through non-hex untouched. */
function withAlpha(hex: string, alphaHex: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex + alphaHex : hex;
}

function deriveColors(theme: PpmTheme): Record<string, string> {
  const t = theme.tokens;
  const colors: Record<string, string> = {
    "editor.background": t.bgSolid,
    "editor.foreground": t.text,
    "editorLineNumber.foreground": t.text3,
    "editorLineNumber.activeForeground": t.text2,
    "editorCursor.foreground": t.accent,
    "editor.selectionBackground": withAlpha(t.accent, "33"),
    "editor.lineHighlightBackground": withAlpha(t.accent, "12"),
    "editorWidget.background": t.bgSolid,
    "editorGutter.background": t.bgSolid,
    "editorIndentGuide.background1": withAlpha(t.text3, "40"),
    "editorWhitespace.foreground": withAlpha(t.text3, "40"),
  };
  return { ...colors, ...theme.editor?.colors };
}

let monacoRef: typeof import("monaco-editor") | null = null;

async function ensureDefined(theme: PpmTheme): Promise<string> {
  const name = monacoThemeName(theme);
  const monaco = monacoRef ?? (monacoRef = await loader.init());
  monaco.editor.defineTheme(name, {
    base: theme.mode === "dark" ? "vs-dark" : "vs",
    inherit: true,
    rules: theme.editor?.rules ?? [],
    colors: deriveColors(theme),
  });
  return name;
}

/** Resolve the current active PpmTheme (prefers the live applied theme). */
function currentTheme(): PpmTheme {
  const s = useSettingsStore.getState();
  return getCurrentAppliedTheme() ?? resolveTheme(s.themeStyle, s.themeMode, s.customThemes, s.customThemeId);
}

let subscribed = false;

/**
 * Define + activate the Monaco theme for the current app theme, and keep it in
 * sync on theme changes. `monaco.editor.setTheme` applies globally to every
 * mounted editor. Idempotent.
 */
export function initMonacoThemeSync(): void {
  if (subscribed || typeof window === "undefined") return;
  subscribed = true;
  const apply = async () => {
    const name = await ensureDefined(currentTheme());
    (monacoRef ?? (monacoRef = await loader.init())).editor.setTheme(name);
  };
  window.addEventListener(THEME_CHANGE_EVENT, () => void apply());
  void apply();
}
