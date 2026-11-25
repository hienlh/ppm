import type { RouteMethod } from "../assistant-mcp/assistant-route-rules.ts";

/**
 * The shape of the settings catalog: every setting the PPM Assistant may read and change, and
 * how. Data plus small functions — the catalog files (`settings-catalog-*.ts`) are lists of these.
 *
 * Reads happen in-process (the same getters the routes use); writes always go through the route
 * the Settings pane calls (`write` returns the call), so validation, logging and the
 * `settings:changed` broadcast stay the route's.
 */

/**
 * `direct`: Full mode changes it with no card (Ask mode still asks). `card`: a card every time,
 * Full mode included — the reason is on the card.
 */
export type SettingTier = "direct" | "card";

export type ValueSpec =
  | { type: "boolean" }
  | { type: "enum"; values: readonly string[] | (() => readonly string[]); labels?: Readonly<Record<string, string>> }
  | { type: "int"; min: number; max: number; unit?: string }
  /** A 24-hour "HH:MM". */
  | { type: "time" }
  | { type: "text"; maxLength: number; multiline?: boolean }
  | { type: "string_list"; maxItems: number; maxLength: number }
  | { type: "id_list"; maxItems: number };

export interface WriteCall {
  method: RouteMethod;
  path: string;
  body: Record<string, unknown>;
}

export interface SettingEntry {
  /** Stable id the agent names: `voice.cleanup_enabled`. */
  key: string;
  /** The Settings category the pane lives in (`settings-categories.ts`). */
  category: string;
  /** "Voice Input → Haiku clean-up". */
  label: string;
  /** The tier of a change; `cardWhen` can make a `direct` setting ask for some changes only. */
  tier: SettingTier;
  /** For `card` (or a change `cardWhen` picks): why it asks even in Full mode. */
  cardReason?: string;
  /**
   * For a `direct` setting that asks only in one direction: true when going from `before` to
   * `after` needs a card (lowering a history limit, switching approval alerts off).
   */
  cardWhen?: (before: unknown, after: unknown) => boolean;
  /** Says when `cardWhen` asks, for `settings_get`. */
  cardWhenText?: string;
  value: ValueSpec;
  /** The value now, as the pane would show it. */
  read(): unknown | Promise<unknown>;
  /** The route call that stores `value` (already checked against `value`). */
  write(value: unknown): WriteCall | Promise<WriteCall>;
  /** A warning line for the card when the new value deserves one. */
  warn?(value: unknown): string | null;
  /**
   * For a value the shape check cannot judge alone (a list that may only lose items, or get back
   * ones taken out earlier): why going from `before` to `value` is refused, or null. Asked before
   * any card, so a change PPM cannot make is never offered to the user.
   */
  validate?(value: unknown, before: unknown): string | null;
  /**
   * For a setting that only summarises others (one switch over two places): the changes `value`
   * stands for, made and logged one by one, so each row keeps its own old value and an undo puts
   * back exactly what was there. Reading the summary still works, and so does undoing a row
   * written under it before it was split.
   */
  expand?(value: unknown): Array<{ key: string; value: unknown }>;
  /** Said with the value: when it takes effect, what else it touches. */
  note?: string;
}

/** A setting the Assistant may name but never change (or read, for a secret). */
export interface RefusedSetting {
  key: string;
  category: string;
  label: string;
  reason: string;
  /** A secret: `settings_get` answers only whether one is stored. */
  isSet?: () => boolean;
  /** A tool that does this job instead (`public_link_set`, `schedule_save`). */
  useInstead?: string;
}

/** A Settings category with nothing in the catalog, and why (checked by a test against the rail). */
export interface UncoveredCategory {
  category: string;
  reason: string;
}

/** The tier of this change: the setting's own, or `card` when `cardWhen` says this direction asks. */
export function changeTier(entry: SettingEntry, before: unknown, after: unknown): SettingTier {
  if (entry.tier === "card") return "card";
  return entry.cardWhen?.(before, after) ? "card" : "direct";
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function enumValues(spec: Extract<ValueSpec, { type: "enum" }>): readonly string[] {
  return typeof spec.values === "function" ? spec.values() : spec.values;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `raw` as the entry stores it, or the reason it is refused. Never trusts the agent's types. */
export function checkValue(entry: SettingEntry, raw: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  const spec = entry.value;
  const bad = (what: string) => ({ ok: false as const, error: `${entry.key} must be ${what}` });
  switch (spec.type) {
    case "boolean":
      return typeof raw === "boolean" ? { ok: true, value: raw } : bad("true or false");
    case "enum": {
      const values = enumValues(spec);
      return typeof raw === "string" && values.includes(raw) ? { ok: true, value: raw } : bad(`one of: ${values.join(", ")}`);
    }
    case "int":
      return Number.isInteger(raw) && (raw as number) >= spec.min && (raw as number) <= spec.max
        ? { ok: true, value: raw }
        : bad(`a whole number from ${spec.min} to ${spec.max}`);
    case "time":
      return typeof raw === "string" && TIME.test(raw) ? { ok: true, value: raw } : bad('a 24-hour time "HH:MM"');
    case "text":
      if (typeof raw !== "string" || raw.length > spec.maxLength) return bad(`text of at most ${spec.maxLength} characters`);
      if (!spec.multiline && /[\r\n]/.test(raw)) return bad("one line of text");
      return { ok: true, value: raw };
    case "string_list":
      return Array.isArray(raw) && raw.length <= spec.maxItems && raw.every((s) => typeof s === "string" && s.length <= spec.maxLength)
        ? { ok: true, value: [...new Set((raw as string[]).map((s) => s.trim()).filter(Boolean))] }
        : bad(`a list of at most ${spec.maxItems} strings`);
    case "id_list":
      return Array.isArray(raw) && raw.length <= spec.maxItems && raw.every((n) => Number.isInteger(n) && n > 0)
        ? { ok: true, value: [...new Set(raw as number[])].sort((a, b) => a - b) }
        : bad(`a list of at most ${spec.maxItems} positive ids`);
  }
}

/** A value as a person reads it on a card, in history and on Telegram. */
export function formatValue(entry: SettingEntry, value: unknown): string {
  const spec = entry.value;
  if (value === undefined || value === null) return "Not set";
  switch (spec.type) {
    case "boolean": return value ? "On" : "Off";
    case "enum": return spec.labels?.[String(value)] ?? String(value);
    case "int": return `${value}${spec.unit ? ` ${spec.unit}` : ""}`;
    case "time": return String(value);
    case "text": return value === "" ? "(empty)" : String(value);
    case "string_list":
    case "id_list": return Array.isArray(value) && value.length ? value.join(", ") : "(none)";
  }
}

/** Two stored values are the same setting state (lists and objects compared by content). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (isObj(a) || isObj(b) || Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}
