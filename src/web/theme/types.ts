/**
 * Theme engine type contract.
 *
 * A theme is a plain data object. Its token values are written to CSS custom
 * properties on `<html>` at runtime (see apply-theme.ts). Surface adapters
 * (Monaco / xterm / Glide / Shiki — Phase 2) read the optional `editor`,
 * `terminal`, `syntax` fields to recolor non-DOM surfaces.
 */

/** Visual style axis. `custom` = an imported VSCode theme. */
export type PpmThemeStyle = "aurora" | "slate" | "precision" | "custom";

/** Mode axis. `system` resolves to dark/light from the OS at apply time. */
export type PpmThemeMode = "dark" | "light" | "system";

/**
 * Full token contract — every built-in defines all of these.
 * Keys are camelCase; apply-theme converts each to a `--kebab-case` CSS var
 * (e.g. `panel2` → `--panel-2`, `accentWashBorder` → `--accent-wash-border`).
 */
export interface PpmThemeTokens {
  /** App background — may be a gradient (Aurora) or a solid color. */
  bg: string;
  /** Solid fallback used wherever a gradient is invalid (meta theme-color, canvas). */
  bgSolid: string;
  /** Sidebar rail background. Falls back to `panel` when a theme omits it. */
  rail: string;
  /** Surface (cards, panels). */
  panel: string;
  /** Elevated surface (popover, dropdown, sheet). */
  panel2: string;
  /** Primary hairline border. */
  border: string;
  /** Faint divider. */
  borderSoft: string;
  /** Primary text. */
  text: string;
  /** Secondary text. */
  text2: string;
  /** Subtle / muted text. */
  text3: string;
  /** PPM accent (active tabs, links, primary buttons, focus). */
  accent: string;
  /** Foreground on top of accent fills. */
  accentFg: string;
  /** Secondary accent (edit-tool icons, syntax). */
  accent2: string;
  /** Tinted selection / own-content fill. */
  accentWash: string;
  /** Border for accent-wash fills. */
  accentWashBorder: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  shadowPanel: string;
  shadowFloat: string;
  /** Card / panel radius. */
  rad: string;
  /** Chip / button radius. */
  radSm: string;
  /** Backdrop blur (glass themes only; "0px" disables). */
  blur: string;
}

/** A single Monaco tokenColor rule (VSCode `tokenColors[]` shape). */
export interface MonacoTokenRule {
  token: string;
  foreground?: string;
  fontStyle?: string;
}

/** Monaco editor theming derived from VSCode tokenColors + workbench colors. */
export interface PpmEditorTheme {
  /** `vs` or `vs-dark` base to inherit from. */
  base: "vs" | "vs-dark" | "hc-black";
  rules: MonacoTokenRule[];
  /** Workbench color overrides keyed by Monaco color id (e.g. "editor.background"). */
  colors: Record<string, string>;
}

/** xterm ANSI palette + cursor/selection. */
export interface PpmTerminalTheme {
  /** 16-color ANSI palette, index 0-15. */
  ansi: string[];
  cursor: string;
  cursorAccent?: string;
  selection: string;
}

/** Syntax highlighting source for Shiki. */
export interface PpmSyntaxTheme {
  /** Name of a bundled Shiki theme, OR raw VSCode theme JSON (imported). */
  shikiTheme: string | Record<string, unknown>;
}

export interface PpmTheme {
  /** Stable id, e.g. "aurora-dark" or a custom uuid. */
  id: string;
  /** Human label shown in the picker. */
  name: string;
  style: PpmThemeStyle;
  /** Concrete mode this data represents (never "system"). */
  mode: "dark" | "light";
  tokens: PpmThemeTokens;
  /** 3-color preview: [bg, accent, accent2]. */
  swatch: [string, string, string];
  /** Token overrides applied only on mobile viewports (legibility bumps). */
  mobileOverrides?: Partial<PpmThemeTokens>;
  /** Populated in Phase 2 for surface adapters. */
  editor?: PpmEditorTheme;
  terminal?: PpmTerminalTheme;
  syntax?: PpmSyntaxTheme;
}
