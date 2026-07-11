import { randomUUID } from "node:crypto";
import { precisionDark, precisionLight } from "../../web/theme/builtin/precision.ts";
import { assertSafeColor, sanitizeName } from "./validate-theme.ts";
import type { PpmTheme, PpmThemeTokens, MonacoTokenRule } from "../../web/theme/types.ts";

/**
 * Convert a VSCode color-theme JSON into a PpmTheme (1-way, lossy). Missing
 * workbench keys fall back to Precision defaults for the theme's mode. Every
 * color pulled from the untrusted JSON is validated before use.
 *
 * Syntax highlighting deliberately maps to a trusted bundled Shiki theme
 * (by mode) rather than feeding the untrusted JSON into Shiki — this removes
 * that attack surface while chrome/Monaco/xterm still match the import.
 */

type ColorMap = Record<string, unknown>;

interface VscodeTheme {
  name?: string;
  type?: string;
  colors?: ColorMap;
  tokenColors?: Array<{ scope?: string | string[]; settings?: { foreground?: string; fontStyle?: string } }>;
}

/** Safe color pick with fallback; validates the raw value against the color allowlist. */
function pick(colors: ColorMap | undefined, keys: string[], fallback: string): string {
  for (const key of keys) {
    const raw = colors?.[key];
    if (typeof raw === "string") {
      try {
        return assertSafeColor(raw, key);
      } catch {
        // try next key / fall through
      }
    }
  }
  return fallback;
}

/** VSCode tokenColors → Monaco rules (foreground stored without leading '#'). */
function toMonacoRules(tokenColors: VscodeTheme["tokenColors"]): MonacoTokenRule[] {
  const rules: MonacoTokenRule[] = [];
  if (!Array.isArray(tokenColors)) return rules;
  for (const tc of tokenColors) {
    const scopes = Array.isArray(tc.scope) ? tc.scope : tc.scope ? [tc.scope] : [];
    const fg = tc.settings?.foreground;
    let safeFg: string | undefined;
    if (typeof fg === "string") {
      try { safeFg = assertSafeColor(fg, "tokenColor").replace(/^#/, ""); } catch { safeFg = undefined; }
    }
    const fontStyle = typeof tc.settings?.fontStyle === "string" && /^[a-z ]{0,24}$/.test(tc.settings.fontStyle)
      ? tc.settings.fontStyle
      : undefined;
    if (!safeFg && !fontStyle) continue;
    for (const scope of scopes.slice(0, 200)) {
      if (typeof scope === "string" && scope.length <= 80) {
        rules.push({ token: scope, ...(safeFg ? { foreground: safeFg } : {}), ...(fontStyle ? { fontStyle } : {}) });
      }
    }
  }
  return rules.slice(0, 1000);
}

export function convertVscodeTheme(input: VscodeTheme, nameHint?: string): PpmTheme {
  const mode: "dark" | "light" = input.type === "light" ? "light" : "dark";
  const d = mode === "light" ? precisionLight.tokens : precisionDark.tokens;
  const c = input.colors;

  const bgSolid = pick(c, ["editor.background"], d.bgSolid);
  const accent = pick(c, ["focusBorder", "button.background"], d.accent);
  const accent2 = pick(c, ["terminalCursor.foreground", "charts.purple"], d.accent2);

  const tokens: PpmThemeTokens = {
    bg: bgSolid,
    bgSolid,
    rail: pick(c, ["sideBar.background", "activityBar.background"], d.rail),
    panel: pick(c, ["sideBar.background"], d.panel),
    panel2: pick(c, ["editorWidget.background", "panel.background", "dropdown.background"], d.panel2),
    border: pick(c, ["panel.border", "contrastBorder", "editorGroup.border"], d.border),
    borderSoft: pick(c, ["sideBar.border", "editorGroup.border"], d.borderSoft),
    text: pick(c, ["foreground", "editor.foreground"], d.text),
    text2: pick(c, ["descriptionForeground"], d.text2),
    text3: pick(c, ["disabledForeground"], d.text3),
    accent,
    accentFg: pick(c, ["button.foreground"], d.accentFg),
    accent2,
    accentWash: pick(c, ["list.activeSelectionBackground", "list.inactiveSelectionBackground"], d.accentWash),
    accentWashBorder: pick(c, ["list.focusOutline", "focusBorder"], d.accentWashBorder),
    success: pick(c, ["charts.green", "gitDecoration.addedResourceForeground"], d.success),
    warning: pick(c, ["charts.yellow", "editorWarning.foreground"], d.warning),
    error: pick(c, ["charts.red", "editorError.foreground"], d.error),
    info: pick(c, ["charts.blue"], d.info),
    // Shape tokens are defaulted (no VSCode equivalent) → trusted values.
    shadowPanel: d.shadowPanel,
    shadowFloat: d.shadowFloat,
    rad: d.rad,
    radSm: d.radSm,
    blur: "0px",
  };

  const name = sanitizeName(nameHint ?? input.name);

  return {
    id: `custom-${randomUUID()}`,
    name,
    style: "custom",
    mode,
    tokens,
    swatch: [tokens.bgSolid, tokens.accent, tokens.accent2],
    editor: {
      base: mode === "dark" ? "vs-dark" : "vs",
      rules: toMonacoRules(input.tokenColors),
      colors: {},
    },
    syntax: { shikiTheme: mode === "light" ? "github-light" : "github-dark-dimmed" },
  };
}
