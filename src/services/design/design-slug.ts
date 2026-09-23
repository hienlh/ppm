/**
 * A design slug names the folder `designs/<slug>/` and is interpolated into the agent's
 * instructions, so it must be a single safe path segment: lowercase ASCII letters, digits
 * and hyphens, starting with a letter or digit, at most 63 characters. Anything that could
 * form `..`, a separator, or a drive letter is rejected by construction rather than by a
 * blocklist.
 */
export const DESIGN_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

const MAX_SLUG_LENGTH = 63;

export function isValidDesignSlug(value: unknown): value is string {
  return typeof value === "string" && DESIGN_SLUG_RE.test(value);
}

/**
 * Derive a slug from a human title ("Landing page — v2" → "landing-page-v2").
 * Accents are folded to ASCII first so a Vietnamese or French title keeps its letters
 * instead of collapsing to hyphens. Returns "" when nothing usable remains, so the caller
 * decides the fallback name rather than this function inventing one.
 */
export function slugFromTitle(title: string): string {
  const folded = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    // Vietnamese đ/Đ is a letter of its own, not a base letter plus a mark.
    .replace(/[đĐ]/g, "d")
    .toLowerCase();
  const slug = folded
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, "");
  return isValidDesignSlug(slug) ? slug : "";
}
