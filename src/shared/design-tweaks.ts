/**
 * Tweak controls a design declares in `design.json` (`tweaks[]`), each bound to one CSS
 * custom property: a `range`, a `color` or a `select`. Shared by the server (authoritative
 * validation before a value is written into a stylesheet) and the browser (the panel).
 *
 * A tweak value ends up inside CSS text, so it is an injection surface. Values are checked
 * against a per-type allowlist, never a denylist: a denylist that forgets `/*` lets a value
 * open a comment that swallows the rest of the rule, and one that forgets an unbalanced `(`
 * lets a value open a function block that swallows every later `;` and `}` in the sheet.
 */

export const MAX_TWEAKS = 24;
export const MAX_SELECT_OPTIONS = 12;
export const MAX_TWEAK_LABEL = 60;
export const TWEAK_UNITS = ["", "px", "rem", "em", "%", "deg"] as const;
export type TweakUnit = (typeof TWEAK_UNITS)[number];

export const TWEAK_VAR_RE = /^--[a-zA-Z0-9_-]{1,48}$/;
export const TWEAK_ID_RE = /^[A-Za-z0-9_-]{1,48}$/;
export const RANGE_VALUE_RE = /^-?\d{1,6}(\.\d{1,4})?(px|rem|em|%|deg)?$/;
export const COLOR_VALUE_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
/** The widest charset any tweak value may use; select options are held to it at parse time. */
export const TWEAK_VALUE_CHARS_RE = /^[A-Za-z0-9 #.,%()-]{1,64}$/;
/** CSS functions a select option may call; anything else (`url(`, `expression(`) is refused. */
const ALLOWED_FUNCTIONS = new Set(["rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "calc", "min", "max", "clamp", "var"]);
/** A tweak's optional append target: a plain relative `.css`/`.html` path inside the design. */
const TWEAK_FILE_RE = /\.(css|html?)$/i;

interface TweakBase {
  id: string;
  label: string;
  var: string;
  /** Where to append the variable when no stylesheet declares it yet. */
  file?: string;
}
export interface RangeTweak extends TweakBase { type: "range"; min: number; max: number; step: number; unit: TweakUnit; default: number }
export interface ColorTweak extends TweakBase { type: "color"; default: string }
export interface SelectTweak extends TweakBase { type: "select"; options: Array<{ label: string; value: string }>; default: string }
export type TweakDef = RangeTweak | ColorTweak | SelectTweak;

export interface ParsedTweaks {
  tweaks: TweakDef[];
  /** One line per skipped entry, shown to the user as "N tweaks ignored". */
  errors: string[];
}

/** The example embedded verbatim in the design instructions; a test parses it with zero errors. */
export const TWEAK_SCHEMA_EXAMPLE = {
  tweaks: [
    { id: "accent", label: "Accent colour", type: "color", var: "--accent", default: "#6366f1" },
    { id: "radius", label: "Corner radius", type: "range", var: "--radius", min: 0, max: 32, step: 1, unit: "px", default: 12 },
    {
      id: "heading-font", label: "Heading font", type: "select", var: "--heading-font",
      options: [{ label: "Sans", value: "Inter, sans-serif" }, { label: "Serif", value: "Georgia, serif" }],
      default: "Inter, sans-serif",
    },
  ],
} as const;

/** The shape check every tweak value passes: charset, no comment markers, balanced, allowed functions. */
export function isSafeTweakValueShape(value: unknown): value is string {
  if (typeof value !== "string" || !TWEAK_VALUE_CHARS_RE.test(value) || value.trim() !== value) return false;
  // Unreachable with today's charset; kept so widening the charset cannot reopen comments.
  if (value.includes("/*") || value.includes("*/")) return false;
  let depth = 0;
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return false;
  }
  if (depth !== 0) return false;
  for (const m of value.matchAll(/([A-Za-z-]*)\(/g)) {
    if (!ALLOWED_FUNCTIONS.has(m[1]!.toLowerCase())) return false;
  }
  return true;
}

/** `12` + `px` → `12px`, without exponent notation or float noise. */
export function formatRangeValue(def: Pick<RangeTweak, "unit">, n: number): string {
  return `${Number(n.toFixed(4))}${def.unit}`;
}

/** The value as it may be written for `def`, or null. */
export function sanitizeTweakValue(def: TweakDef, value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (def.type === "color") return COLOR_VALUE_RE.test(value) ? value : null;
  if (def.type === "select") {
    return def.options.some((o) => o.value === value) && isSafeTweakValueShape(value) ? value : null;
  }
  const m = RANGE_VALUE_RE.exec(value);
  if (!m || (m[2] ?? "") !== def.unit) return null;
  const n = Number(value.slice(0, value.length - def.unit.length));
  return Number.isFinite(n) && n >= def.min && n <= def.max ? value : null;
}

type Raw = Record<string, unknown>;
const isRaw = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);

function cleanLabel(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const label = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return label ? Array.from(label).slice(0, MAX_TWEAK_LABEL).join("") : null;
}

/** Relative, `/`-separated, plain segments only: no `..`, no dot-directory, no absolute path. */
export function isSafeTweakFile(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 200 || !TWEAK_FILE_RE.test(v)) return false;
  return v.split("/").every((seg) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(seg));
}

const boundedNumber = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && RANGE_VALUE_RE.test(String(v)) ? v : null;

function parseRange(e: Raw, base: TweakBase): RangeTweak | string {
  const min = boundedNumber(e.min), max = boundedNumber(e.max), step = boundedNumber(e.step);
  if (min === null || max === null || min >= max) return "needs numeric min < max";
  if (step === null || step <= 0) return "needs a positive step";
  const unit = TWEAK_UNITS.find((u) => u === (e.unit ?? ""));
  if (unit === undefined) return `unit must be one of px, rem, em, %, deg or empty`;
  const raw = typeof e.default === "string" ? Number.parseFloat(e.default) : e.default;
  const def = boundedNumber(raw);
  if (def === null || def < min || def > max) return "default must be a number within min..max";
  return { ...base, type: "range", min, max, step, unit, default: def };
}

function parseSelect(e: Raw, base: TweakBase): SelectTweak | string {
  if (!Array.isArray(e.options) || e.options.length === 0) return "needs options";
  if (e.options.length > MAX_SELECT_OPTIONS) return `has more than ${MAX_SELECT_OPTIONS} options`;
  const options: SelectTweak["options"] = [];
  for (const o of e.options) {
    const label = isRaw(o) ? cleanLabel(o.label) : null;
    if (!isRaw(o) || !label || !isSafeTweakValueShape(o.value)) {
      return "has an option whose value is not plain CSS (letters, digits, spaces and # . , % ( ) - only)";
    }
    if (options.some((x) => x.value === o.value)) return "has two options with the same value";
    options.push({ label, value: o.value });
  }
  if (typeof e.default !== "string" || !options.some((o) => o.value === e.default)) return "default must be one of the options";
  return { ...base, type: "select", options, default: e.default };
}

function parseOne(e: unknown, index: number): TweakDef | string {
  if (!isRaw(e)) return `#${index + 1}: not an object`;
  const where = typeof e.id === "string" && TWEAK_ID_RE.test(e.id) ? `"${e.id}"` : `#${index + 1}`;
  if (typeof e.id !== "string" || !TWEAK_ID_RE.test(e.id)) return `${where}: id must be letters, digits, - or _`;
  const label = cleanLabel(e.label);
  if (!label) return `${where}: needs a label`;
  if (typeof e.var !== "string" || !TWEAK_VAR_RE.test(e.var)) return `${where}: var must look like --name`;
  if (e.file !== undefined && !isSafeTweakFile(e.file)) return `${where}: file must be a .css or .html path inside the design`;
  const base: TweakBase = { id: e.id, label, var: e.var, ...(e.file !== undefined ? { file: e.file as string } : {}) };
  let parsed: TweakDef | string;
  if (e.type === "range") parsed = parseRange(e, base);
  else if (e.type === "select") parsed = parseSelect(e, base);
  else if (e.type === "color") {
    parsed = typeof e.default === "string" && COLOR_VALUE_RE.test(e.default)
      ? { ...base, type: "color", default: e.default } : "default must be a hex colour like #rrggbb";
  } else parsed = "type must be range, color or select";
  return typeof parsed === "string" ? `${where}: ${parsed}` : parsed;
}

/** Valid entries in order; every skipped one is explained. `undefined` means "no tweaks". */
export function parseTweaks(raw: unknown): ParsedTweaks {
  if (raw === undefined || raw === null) return { tweaks: [], errors: [] };
  if (!Array.isArray(raw)) return { tweaks: [], errors: ["tweaks must be an array"] };
  const tweaks: TweakDef[] = [];
  const errors: string[] = [];
  if (raw.length > MAX_TWEAKS) errors.push(`only the first ${MAX_TWEAKS} tweaks are used (${raw.length - MAX_TWEAKS} ignored)`);
  raw.slice(0, MAX_TWEAKS).forEach((entry, i) => {
    const t = parseOne(entry, i);
    if (typeof t === "string") errors.push(t);
    else if (tweaks.some((x) => x.id === t.id)) errors.push(`"${t.id}": duplicate id`);
    else if (tweaks.some((x) => x.var === t.var)) errors.push(`"${t.id}": ${t.var} is already bound to another tweak`);
    else tweaks.push(t);
  });
  return { tweaks, errors };
}
