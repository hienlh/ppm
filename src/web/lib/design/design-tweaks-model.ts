import { COLOR_VALUE_RE, sanitizeTweakValue, type RangeTweak, type TweakDef } from "../../../shared/design-tweaks";

/**
 * The Tweaks panel's pure decisions, kept apart from React so they are testable: which
 * edits are still unapplied, what a control shows for a rendered value it cannot represent,
 * whether a committed value actually took effect, and the chat briefs the panel offers.
 */

/** Rendered values compare equal when they differ only by case or spacing (`#ABC` = `#abc`). */
export function sameTweakValue(a: string | undefined, b: string | undefined): boolean {
  const norm = (v: string | undefined) => (v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  return norm(a) === norm(b);
}

/** The edits that differ from what the page renders and that the server would accept. */
export function pendingChanges(
  defs: readonly TweakDef[],
  edits: Readonly<Record<string, string>>,
  rendered: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const def of defs) {
    const value = edits[def.var];
    if (value === undefined || sameTweakValue(value, rendered[def.var])) continue;
    if (sanitizeTweakValue(def, value) !== null) out[def.var] = value;
  }
  return out;
}

/**
 * Variables whose committed value is not what the reloaded page renders — a later or more
 * specific rule overrides them, or the page does not use the stylesheet that was written.
 */
export function overriddenVars(committed: Readonly<Record<string, string>>, rendered: Readonly<Record<string, string>>): string[] {
  return Object.keys(committed).filter((name) => !sameTweakValue(committed[name], rendered[name]));
}

/** What a control shows: the unapplied edit, else the rendered value, else the manifest default. */
export function shownValue(def: TweakDef, edits: Readonly<Record<string, string>>, rendered: Readonly<Record<string, string>>): string {
  const edit = edits[def.var];
  if (edit !== undefined) return edit;
  const current = rendered[def.var];
  if (current) return current;
  return def.type === "range" ? `${def.default}${def.unit}` : def.default;
}

/** `<input type=color>` only takes `#rrggbb`: expand `#rgb`, drop an alpha channel, else fall back. */
export function hexForColorInput(value: string, fallback: string): string {
  const v = value.trim();
  if (!COLOR_VALUE_RE.test(v)) return COLOR_VALUE_RE.test(fallback) ? hexForColorInput(fallback, "#000000") : "#000000";
  if (v.length === 4) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase();
  return v.slice(0, 7).toLowerCase();
}

/** The slider position for a rendered value; a value it cannot parse (`calc(...)`) shows the default. */
export function rangeNumberOf(def: RangeTweak, value: string): number {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return def.default;
  return Math.min(def.max, Math.max(def.min, n));
}

export function buildAddTweaksPrompt(slug: string): string {
  return [
    `Add a few tweak controls to this design so I can adjust it live from the Tweaks panel.`,
    `Declare them under "tweaks" in designs/${slug}/design.json (colour, radius, spacing, font size — whatever matters most here),`,
    `and keep each value in the design's own unconditional :root block, used through var(--name).`,
  ].join(" ");
}

export function buildFixTweaksPrompt(slug: string, errors: readonly string[]): string {
  return [
    `Some tweaks in designs/${slug}/design.json are invalid and were ignored:`,
    ...errors.map((e) => `- ${e}`),
    `Please fix those entries so they follow the tweak schema.`,
  ].join("\n");
}
