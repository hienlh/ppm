/**
 * Which glyph of the vscode-icons theme a file or folder name resolves to.
 *
 * Split out of `file-icons.tsx` rather than living beside the component,
 * because the component reaches `project-framework-store` and through it the
 * whole api-client/React graph — the same reason `git-file-tree.ts` sits apart
 * from the Source Control panel. This half is pure and has a test; that half
 * draws.
 */
import {
  DEFAULT_FILE_ICON,
  DEFAULT_FOLDER_ICON,
  DEFAULT_FOLDER_OPEN_ICON,
  EXTENSION_ICONS,
  FILENAME_ICONS,
  FOLDER_ICONS,
  FOLDER_OPEN_ICONS,
  FRAMEWORK_EXTENSION_ICONS,
  FRAMEWORK_FILENAME_ICONS,
  MAX_EXTENSION_SEGMENTS,
  type IconFramework,
} from "./file-icons.generated";

/** Strip a path down to its last segment, for either separator. */
function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * The icon name for a file, by name alone.
 *
 * Resolution is the theme's own: the whole filename first, then each dotted
 * suffix from the longest — `foo.app-routing.module.ts` tries
 * `app-routing.module.ts`, then `module.ts`, then `ts`. Matching only the last
 * two segments, which is what this did while the mapping came from
 * `vscode-icons-js`, loses every three-segment pattern the real manifest has
 * (`buf.gen.yaml`, `.php-cs-fixer.dist.php`, `.cspell.config.mts`).
 *
 * `framework` is the project's preset, and it is consulted at each suffix
 * length rather than only at the end: `.controller.ts` has to beat plain `.ts`
 * whichever table it comes from.
 */
export function fileIconName(path: string, framework?: IconFramework | null): string {
  const name = baseName(path).toLowerCase();
  const overlayNames = framework ? FRAMEWORK_FILENAME_ICONS[framework] : undefined;
  const byName = overlayNames?.[name] ?? FILENAME_ICONS[name];
  if (byName) return byName;

  const overlayExtensions = framework ? FRAMEWORK_EXTENSION_ICONS[framework] : undefined;
  const parts = name.split(".");
  // A leading dot makes `parts[0]` empty, so `.npmrc` enters the loop at
  // `npmrc` and needs no case of its own.
  for (let i = Math.max(1, parts.length - MAX_EXTENSION_SEGMENTS); i < parts.length; i++) {
    const suffix = parts.slice(i).join(".");
    const hit = overlayExtensions?.[suffix] ?? EXTENSION_ICONS[suffix];
    if (hit) return hit;
  }
  return DEFAULT_FILE_ICON;
}

/** The icon name for a folder, open or closed. */
export function folderIconName(path: string, open = false): string {
  const name = baseName(path).toLowerCase();
  const table = open ? FOLDER_OPEN_ICONS : FOLDER_ICONS;
  return table[name] ?? (open ? DEFAULT_FOLDER_OPEN_ICON : DEFAULT_FOLDER_ICON);
}
