import type { PpmThemeTokens } from "./types";

/**
 * Canonical order of token keys. Source of truth for iteration in apply-theme.
 * Every built-in and every imported theme must supply all of these.
 */
export const TOKEN_KEYS: (keyof PpmThemeTokens)[] = [
  "bg",
  "bgSolid",
  "rail",
  "panel",
  "panel2",
  "border",
  "borderSoft",
  "text",
  "text2",
  "text3",
  "accent",
  "accentFg",
  "accent2",
  "accentWash",
  "accentWashBorder",
  "success",
  "warning",
  "error",
  "info",
  "shadowPanel",
  "shadowFloat",
  "rad",
  "radSm",
  "blur",
];

/**
 * camelCase token key → `--kebab-case` CSS var name.
 * Inserts a hyphen before an uppercase letter or a digit so that
 * `panel2` → `panel-2` and `accentWashBorder` → `accent-wash-border`.
 */
export function tokenToCssVar(key: string): string {
  return "--" + key.replace(/([a-z])([A-Z0-9])/g, "$1-$2").toLowerCase();
}
