/**
 * Resolving a desktop entry's Icon to a file PPM can serve.
 *
 * An Icon is either an absolute path or a theme icon NAME, and the name is the
 * common case: on this host `code.desktop` says `Icon=vscode`, which exists only
 * under /usr/share/pixmaps, while `org.kde.dolphin` is an SVG under hicolor and
 * `claude-desktop` is a PNG under hicolor's sized directories. A resolver that
 * searches only the current theme finds none of the three.
 *
 * So the whole search path is indexed once, name to path: measured here, 22022
 * names in 29 ms. That is far cheaper than walking per lookup and it is built
 * lazily, on the first icon anyone actually asks for.
 *
 * The index is also the security boundary. The HTTP route never takes a path - it
 * takes an app id, looks the entry up, and serves only what this module resolved,
 * so there is no request shape that can name an arbitrary file.
 */
import type { LinuxFs } from "../system-metrics/linux-fs.ts";
import { realLinuxFs } from "../system-metrics/linux-fs.ts";

/** Preference order: a vector icon scales to any row height the UI uses. */
export const ICON_EXTENSIONS: readonly string[] = [".svg", ".png", ".xpm"];

/** How deep a theme nests: theme / context / size / name, plus a little slack. */
const MAX_DEPTH = 5;

export const ICON_MIME: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".xpm": "image/x-xpixmap",
};

export function iconRoots(env: Record<string, string | undefined>, home: string): string[] {
  const dataHome = env.XDG_DATA_HOME || `${home}/.local/share`;
  const dataDirs = (env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(Boolean);
  const roots: string[] = [`${home}/.icons`, `${dataHome}/icons`];
  for (const base of dataDirs) roots.push(`${base}/icons`);
  // pixmaps is not a theme and is easy to forget; it is also the ONLY place some
  // very common icons exist, so leaving it out loses them entirely.
  for (const base of dataDirs) roots.push(`${base}/pixmaps`);
  return [...new Set(roots)];
}

/**
 * name to path. An earlier root wins over a later one, and within a root a better
 * extension replaces a worse one - so a theme's SVG beats the same theme's PNG
 * without needing the walk to be ordered by size.
 */
export function buildIconIndex(roots: readonly string[], fs: LinuxFs): Map<string, string> {
  const index = new Map<string, string>();
  const rank = new Map<string, number>();
  const walk = (dir: string, depth: number, rootOrder: number): void => {
    if (depth > MAX_DEPTH) return;
    const entries = fs.list(dir);
    if (!entries) return;
    for (const name of entries) {
      const path = `${dir}/${name}`;
      const dot = name.lastIndexOf(".");
      const ext = dot > 0 ? name.slice(dot) : "";
      const extRank = ICON_EXTENSIONS.indexOf(ext);
      if (extRank < 0) {
        // No known extension: treat it as a directory and descend. A plain file
        // simply lists as nothing and costs one failed readdir.
        walk(path, depth + 1, rootOrder);
        continue;
      }
      const base = name.slice(0, dot);
      const score = rootOrder * 10 + extRank;
      const previous = rank.get(base);
      if (previous === undefined || score < previous) {
        rank.set(base, score);
        index.set(base, path);
      }
    }
  };
  roots.forEach((root, order) => walk(root, 0, order));
  return index;
}

/**
 * The file for one Icon value, or null when nothing resolves.
 *
 * An absolute path is taken from the entry itself, which is host-owned content -
 * but it is still required to be an image extension, so a malformed entry cannot
 * turn the icon route into a reader of arbitrary files.
 */
export function resolveIconPath(
  icon: string | null,
  index: Map<string, string>,
  fs: LinuxFs,
): string | null {
  if (!icon) return null;
  if (icon.startsWith("/")) {
    return hasImageExtension(icon) && fs.exists(icon) ? icon : null;
  }
  // Some entries write the file name rather than the icon name ("foo.png").
  const dot = icon.lastIndexOf(".");
  const stem = dot > 0 && ICON_EXTENSIONS.includes(icon.slice(dot)) ? icon.slice(0, dot) : icon;
  return index.get(stem) ?? index.get(icon) ?? null;
}

export function hasImageExtension(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot > 0 && ICON_EXTENSIONS.includes(path.slice(dot).toLowerCase());
}

export function iconMimeType(path: string): string {
  const dot = path.lastIndexOf(".");
  return ICON_MIME[dot > 0 ? path.slice(dot).toLowerCase() : ""] ?? "application/octet-stream";
}

/** Production wiring: one lazily-built index for the process's lifetime. */
export function createIconResolver(fs: LinuxFs = realLinuxFs) {
  const roots = iconRoots(process.env, process.env.HOME ?? "/root");
  let index: Map<string, string> | null = null;
  return {
    resolve(icon: string | null): string | null {
      index ??= buildIconIndex(roots, fs);
      return resolveIconPath(icon, index, fs);
    },
  };
}

export type IconResolver = ReturnType<typeof createIconResolver>;
