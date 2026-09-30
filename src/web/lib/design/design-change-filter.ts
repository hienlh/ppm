/**
 * What a `file:changed` path means for an open design canvas.
 *
 * - `reload`: something the page renders changed — any file in the design's folder, or the
 *   project's shared `designs/tokens.css`, which every design links.
 * - `manifest`: the design's `design.json` (its title or kind), or the folder itself
 *   (created, or deleted from under the tab).
 * - `null`: anything else, including `.design/`, which holds snapshots and comments and is
 *   announced by its own `design:*` events rather than by the file watcher.
 *
 * Paths arrive project-relative with forward slashes; a stray backslash or leading `./` is
 * normalised anyway, because a miss here reads as "live reload is broken".
 */
export type DesignChange = "reload" | "manifest" | null;

export function classifyDesignChange(path: string, slug: string): DesignChange {
  if (!path || !slug) return null;
  const p = path.replaceAll("\\", "/").replace(/^(\.\/|\/)+/, "");
  if (p === "designs/tokens.css") return "reload";
  const root = `designs/${slug}`;
  if (p === root) return "manifest";
  if (!p.startsWith(`${root}/`)) return null;
  const rest = p.slice(root.length + 1);
  if (!rest || rest === ".design" || rest.startsWith(".design/")) return null;
  if (rest === "design.json") return "manifest";
  return "reload";
}

/**
 * Whether a change may add or remove a variant: an HTML page at the top of the design folder
 * other than the entry. The server lists only variants whose file exists, so an agent writing
 * `design.json` before `variant-2.html` leaves the switcher one page short until the page
 * itself lands — which is when the list has to be fetched again.
 */
export function mayChangeVariants(path: string, slug: string, entry: string): boolean {
  if (classifyDesignChange(path, slug) !== "reload") return false;
  const rest = path.replaceAll("\\", "/").replace(/^(\.\/|\/)+/, "").slice(`designs/${slug}/`.length);
  return !rest.includes("/") && /\.html?$/i.test(rest) && rest.toLowerCase() !== entry.toLowerCase();
}
