import type { PpmTheme, PpmThemeStyle } from "../types";
import { auroraDark, auroraLight } from "./aurora";
import { slateDark, slateLight } from "./slate";
import { precisionDark, precisionLight } from "./precision";

/** All built-in themes keyed by `${style}-${mode}`. */
export const BUILTIN_THEMES: Record<string, PpmTheme> = {
  "aurora-dark": auroraDark,
  "aurora-light": auroraLight,
  "slate-dark": slateDark,
  "slate-light": slateLight,
  "precision-dark": precisionDark,
  "precision-light": precisionLight,
};

/** Picker display order. */
export const BUILTIN_ORDER: string[] = [
  "aurora-dark",
  "aurora-light",
  "slate-dark",
  "slate-light",
  "precision-dark",
  "precision-light",
];

export const DEFAULT_THEME = auroraDark;

/** Built-in style axis values (excludes "custom"). */
export const BUILTIN_STYLES: PpmThemeStyle[] = ["aurora", "slate", "precision"];
