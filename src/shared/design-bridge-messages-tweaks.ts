import { MAX_TWEAKS, TWEAK_VAR_RE, isSafeTweakValueShape } from "./design-tweaks";

/**
 * Bridge messages for tweak controls, spread into the protocol's registries.
 *
 * Parent → frame: `tweak-set` (live values, applied as inline custom properties on the
 * document element), `tweak-reset` (drop those overrides again) and `tweak-read` (report
 * the rendered values). Frame → parent: `tweak-values`, the answer to a read.
 *
 * `tweak-values` is untrusted like everything the frame sends: it only fills the panel's
 * controls and the "overridden" hint. What gets written is decided by the parent, from its
 * own state, and re-validated by the server against the manifest.
 */

/** Which kind of rule the frame found setting a variable last, among the sheets it can read. */
export type TweakWinner = "root" | "conditional" | "other" | "unknown";
const WINNERS: readonly TweakWinner[] = ["root", "conditional", "other", "unknown"];
/** Longest rendered value reported back; a custom property can hold far more than a tweak needs. */
export const MAX_READ_VALUE = 200;

type Raw = Record<string, unknown>;
const isRaw = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);

function varMap<T>(v: unknown, item: (x: unknown) => T | null): Record<string, T> | null {
  if (!isRaw(v)) return null;
  const entries = Object.entries(v);
  if (entries.length > MAX_TWEAKS) return null;
  const out: Record<string, T> = {};
  for (const [name, value] of entries) {
    const parsed = item(value);
    if (!TWEAK_VAR_RE.test(name) || parsed === null) return null;
    out[name] = parsed;
  }
  return out;
}

function varList(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > MAX_TWEAKS) return null;
  return v.every((x) => typeof x === "string" && TWEAK_VAR_RE.test(x)) ? (v as string[]) : null;
}

export const TWEAK_CHILD_VALIDATORS = {
  "tweak-values": (m: Raw) => {
    const values = varMap(m.values, (x) => (typeof x === "string" ? x.slice(0, MAX_READ_VALUE) : null));
    const winners = varMap(m.winners, (x) => WINNERS.find((w) => w === x) ?? null);
    return values && winners ? { type: "tweak-values" as const, values, winners } : null;
  },
};

export const TWEAK_PARENT_VALIDATORS = {
  "tweak-set": (m: Raw) => {
    const values = varMap(m.values, (x) => (isSafeTweakValueShape(x) ? x : null));
    return values ? { type: "tweak-set" as const, values } : null;
  },
  /** No `vars`: every override the bridge set. */
  "tweak-reset": (m: Raw) => {
    if (m.vars === undefined) return { type: "tweak-reset" as const };
    const vars = varList(m.vars);
    return vars ? { type: "tweak-reset" as const, vars } : null;
  },
  "tweak-read": (m: Raw) => {
    const vars = varList(m.vars);
    return vars ? { type: "tweak-read" as const, vars } : null;
  },
};
