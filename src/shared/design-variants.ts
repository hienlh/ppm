/**
 * Design variants: alternative directions for one brief, one HTML file each, that the canvas
 * switches between. `design.json` lists them as `variants: [{ file, label }]`, variant 1
 * being the design's entry page.
 *
 * The list is written by the agent, so it is parsed tolerantly: every bad entry is dropped
 * with a warning the canvas shows, and whatever survives is still a usable list whose first
 * item is the entry. A missing list is just the entry, which is also what an older build that
 * ignores the field shows.
 */

export const MAX_DESIGN_VARIANTS = 5;
export const MAX_VARIANT_LABEL = 40;

export interface DesignVariant {
  /** A plain file name in the design folder, e.g. `variant-2.html`. */
  file: string;
  /** Short name of the direction; empty when the agent gave none. */
  label: string;
}

export interface ParsedVariants {
  variants: DesignVariant[];
  warnings: string[];
}

/**
 * A top-level HTML file: no directories, no leading dot (that would reach `.design/`). Kept
 * flat so the chosen variant can take the entry's place without its relative links moving.
 */
const VARIANT_FILE_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}\.html?$/i;

export function isVariantFileName(value: unknown): value is string {
  return typeof value === "string" && VARIANT_FILE_RE.test(value);
}

/** Trimmed, control characters removed, at most {@link MAX_VARIANT_LABEL} characters. */
export function normalizeVariantLabel(value: unknown): string {
  if (typeof value !== "string") return "";
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(flat).slice(0, MAX_VARIANT_LABEL).join("");
}

/** A file name as it may appear in a warning: the agent wrote it, so it is cut short. */
const shown = (value: unknown): string =>
  (typeof value === "string" ? value : String(value)).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 60);

/** Case-folded, because Windows and macOS treat `Variant-2.html` and `variant-2.html` as one file. */
const sameFile = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export function parseDesignVariants(value: unknown, entry: string): ParsedVariants {
  const warnings: string[] = [];
  const entryItem = (label = ""): DesignVariant => ({ file: entry, label });
  if (value === undefined || value === null) return { variants: [entryItem()], warnings };
  if (!Array.isArray(value)) {
    return { variants: [entryItem()], warnings: ["`variants` in design.json is not a list, so only the entry page is shown."] };
  }
  if (entry.includes("/")) {
    return { variants: [entryItem()], warnings: ["Variants need the entry page at the top of the design folder, so only the entry page is shown."] };
  }

  const list: DesignVariant[] = [];
  value.forEach((raw: unknown, i) => {
    const file = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).file : undefined;
    if (typeof file !== "string" || !file) {
      warnings.push(`Variant ${i + 1} in design.json has no file name and was skipped.`);
    } else if (!isVariantFileName(file)) {
      warnings.push(`"${shown(file)}" is not an HTML file at the top of the design folder and was skipped.`);
    } else if (list.some((v) => sameFile(v.file, file))) {
      warnings.push(`${shown(file)} is listed twice in design.json; the second entry was skipped.`);
    } else {
      list.push({ file, label: normalizeVariantLabel((raw as Record<string, unknown>).label) });
    }
  });

  const at = list.findIndex((v) => sameFile(v.file, entry));
  if (at === -1) {
    if (list.length > 0) warnings.push(`Variant 1 must be the entry page ${shown(entry)}; it was added in front.`);
    list.unshift(entryItem());
  } else if (at > 0) {
    warnings.push(`Variant 1 must be the entry page ${shown(entry)}; it was moved in front.`);
    list.unshift(...list.splice(at, 1));
  }
  // The entry keeps the manifest's spelling of its name, whatever case the list used.
  list[0] = { file: entry, label: list[0]!.label };
  if (list.length > MAX_DESIGN_VARIANTS) {
    warnings.push(`design.json lists ${list.length} variants; only the first ${MAX_DESIGN_VARIANTS} are shown.`);
    list.length = MAX_DESIGN_VARIANTS;
  }
  return { variants: list, warnings };
}

/** The variants of a design summary; an older server sends none, which means the entry alone. */
export function designVariantsOf(design: { entry: string; variants?: DesignVariant[] }): DesignVariant[] {
  return design.variants && design.variants.length > 0 ? design.variants : [{ file: design.entry, label: "" }];
}

/** "2 · Bold", or "Variant 2" when the agent gave the direction no name. */
export function variantDisplayName(variant: DesignVariant, index: number): string {
  return variant.label ? `${index + 1} · ${variant.label}` : `Variant ${index + 1}`;
}
