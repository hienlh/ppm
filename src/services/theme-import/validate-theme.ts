import { TOKEN_KEYS } from "../../web/theme/tokens.ts";
import type { PpmTheme, PpmThemeTokens } from "../../web/theme/types.ts";

/**
 * Security boundary for imported themes. Token values become CSS custom
 * properties on <html>, so an unvalidated value could break out of the
 * declaration (`--x: red; } body{display:none`) or smuggle `url()`/`expression`.
 * Everything here is defense against untrusted VSCode theme JSON.
 */

const MAX_VALUE_LEN = 128;
const MAX_NAME_LEN = 64;

/** Substrings that must never appear in any token value. */
const FORBIDDEN = [";", "{", "}", "<", ">", "url(", "expression", "javascript:", "/*", "*/", "\\", "@import", "@"];

/** Color tokens accept hex / rgb(a) / hsl(a) / a short named color only. */
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d.,\s%/]+\)|hsla?\([\d.,\s%/]+\)|[a-zA-Z]{1,20})$/;

/** Length + geometry tokens: `10px`, `0.5rem`, `0`. */
const LENGTH_RE = /^(0|\d{1,4}(\.\d{1,3})?(px|rem|em))$/;

/** Box-shadow tokens: digits, units, spaces, commas, minus, and rgba/hsla only. */
const SHADOW_RE = /^[-\d.,\s()a-z%#]+$/;

const COLOR_TOKENS: (keyof PpmThemeTokens)[] = [
  "bg", "bgSolid", "rail", "panel", "panel2", "border", "borderSoft",
  "text", "text2", "text3", "accent", "accentFg", "accent2",
  "accentWash", "accentWashBorder", "success", "warning", "error", "info",
];
const LENGTH_TOKENS: (keyof PpmThemeTokens)[] = ["rad", "radSm", "blur"];
const SHADOW_TOKENS: (keyof PpmThemeTokens)[] = ["shadowPanel", "shadowFloat"];

function hasForbidden(v: string): boolean {
  const lower = v.toLowerCase();
  return FORBIDDEN.some((f) => lower.includes(f));
}

/** Throws if a color string is unsafe. Used by the converter as it maps values. */
export function assertSafeColor(value: unknown, context: string): string {
  if (typeof value !== "string") throw new Error(`${context}: not a string`);
  const v = value.trim();
  if (v.length === 0 || v.length > MAX_VALUE_LEN) throw new Error(`${context}: bad length`);
  if (hasForbidden(v)) throw new Error(`${context}: forbidden token`);
  if (!COLOR_RE.test(v)) throw new Error(`${context}: not a valid color`);
  return v;
}

/** Strip a name/label to a safe, bounded character set. */
export function sanitizeName(name: unknown): string {
  const s = typeof name === "string" ? name : "";
  const cleaned = s.replace(/[^a-zA-Z0-9 _.\-]/g, "").trim().slice(0, MAX_NAME_LEN);
  return cleaned || "Imported Theme";
}

/**
 * Validate a fully converted PpmTheme before it is stored/applied. Throws on
 * the first violation. Confirms every token exists and matches its category's
 * safe pattern.
 */
export function validatePpmTheme(theme: PpmTheme): void {
  if (!theme || typeof theme !== "object") throw new Error("theme is not an object");
  if (theme.mode !== "dark" && theme.mode !== "light") throw new Error("invalid mode");

  const tokens = theme.tokens;
  if (!tokens || typeof tokens !== "object") throw new Error("tokens missing");

  for (const key of TOKEN_KEYS) {
    const value = tokens[key];
    if (typeof value !== "string" || value.length === 0) throw new Error(`token ${key} missing`);
    if (value.length > MAX_VALUE_LEN) throw new Error(`token ${key} too long`);
    if (hasForbidden(value)) throw new Error(`token ${key} has forbidden content`);
    if (/[-]{2,}/.test(value)) throw new Error(`token ${key} has nested-var pattern`);
  }
  for (const key of COLOR_TOKENS) {
    if (!COLOR_RE.test(tokens[key])) throw new Error(`token ${key} is not a valid color`);
  }
  for (const key of LENGTH_TOKENS) {
    if (!LENGTH_RE.test(tokens[key])) throw new Error(`token ${key} is not a valid length`);
  }
  for (const key of SHADOW_TOKENS) {
    if (!SHADOW_RE.test(tokens[key])) throw new Error(`token ${key} is not a valid shadow`);
  }
  // swatch is derived internally (3 colors) — validate too.
  if (!Array.isArray(theme.swatch) || theme.swatch.length !== 3) throw new Error("bad swatch");
  for (const c of theme.swatch) assertSafeColor(c, "swatch");
}
