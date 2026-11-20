/**
 * Labels for the places list (the sidebar on desktop, the chip strip on a phone).
 *
 * A place is labelled by its folder's name, and two different folders can share one: Windows
 * Quick Access happily pins both `D:\Projects` and `C:\Users\<you>\Projects`, which then showed
 * as two identical "Projects" chips with nothing to tell them apart. Every name that occurs more
 * than once is followed by where that folder sits (`Projects · D:`, `Projects · ~`). The same
 * folder listed twice (a PPM pin of a Quick Access folder) is one place, kept once.
 *
 * Pure, so it is tested without the stores.
 */

import { parentOf, samePath, sepOf, trimEnd } from "./host-path-parts";

export interface NamedPlace {
  name: string;
  path: string;
}

/** Where a folder sits, short: `~` for the home folder, `~\x` inside it, `D:` for a drive root. */
export function placeLocationHint(path: string, home: string | null): string {
  const parent = parentOf(path);
  if (!parent) return trimEnd(path);
  if (home) {
    const h = trimEnd(home);
    if (samePath(parent, h)) return "~";
    const sep = sepOf(parent);
    const prefix = h.endsWith(sep) ? h : h + sep;
    if (parent.length > prefix.length && samePath(parent.slice(0, prefix.length), prefix)) {
      return `~${sep}${parent.slice(prefix.length)}`;
    }
  }
  return parent.replace(/^([A-Za-z]:)[\\/]$/, "$1");
}

/**
 * The places with a `label` each: the name, plus where the folder sits when another place in
 * the list has the same name. A path listed twice is kept once, at its first position.
 */
export function labelPlaces<T extends NamedPlace>(places: readonly T[], home: string | null): (T & { label: string })[] {
  const unique: T[] = [];
  for (const place of places) {
    if (!unique.some((u) => samePath(u.path, place.path))) unique.push(place);
  }
  const count = new Map<string, number>();
  for (const place of unique) count.set(place.name.toLowerCase(), (count.get(place.name.toLowerCase()) ?? 0) + 1);
  return unique.map((place) => ({
    ...place,
    label: (count.get(place.name.toLowerCase()) ?? 0) > 1 ? `${place.name} · ${placeLocationHint(place.path, home)}` : place.name,
  }));
}

/** Label by path for PPM's pins and the host's own pinned folders, judged as one list. */
export function placeLabelMap(
  pins: readonly NamedPlace[],
  host: { homedir: string; pinned: readonly NamedPlace[] } | null,
): Map<string, string> {
  const labelled = labelPlaces([...pins, ...(host?.pinned ?? [])], host?.homedir ?? null);
  return new Map(labelled.map((p) => [p.path, p.label]));
}
