/**
 * The one file icon in the app: the vscode-icons theme, for every surface that
 * lists a file.
 *
 * What it replaces is worth stating, because it looked deliberate: the tree used
 * a single lucide `FileCode` glyph tinted a different colour per language, so
 * twenty languages were the same shape in twenty shades and the eye had nothing
 * to catch. A file icon's whole job is to be recognised before the name is read.
 *
 * Drawn as a `background-image` on a span rather than an inline `<svg>`, for
 * three reasons. These glyphs are full-colour artwork, so there is no
 * `currentColor` to inherit and nothing to gain from having the paths in the
 * DOM. A tree of 500 rows would otherwise carry a few thousand extra path
 * nodes for React to reconcile on every expand. And a row is draggable — an
 * inner `<img>` supplies its own drag image and has to be talked out of it.
 *
 * Resolution order is the extension theme's own: whole filename, then double
 * extension (`.spec.ts`), then extension. `fileIconElement` is for the slots
 * that want a component rather than an element — the tab bar and the palette
 * both take an `icon: ElementType`.
 */
import type { FC } from "react";
import { cn } from "@/lib/utils";
import {
  DEFAULT_FILE_ICON,
  DEFAULT_FOLDER_ICON,
  DEFAULT_FOLDER_OPEN_ICON,
  EXTENSION_ICONS,
  FILENAME_ICONS,
  FOLDER_ICONS,
  FOLDER_OPEN_ICONS,
} from "./file-icons.generated";
import "@/styles/file-icons.generated.css";

/** Strip a path down to its last segment, for either separator. */
function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut === -1 ? path : path.slice(cut + 1);
}

/** The icon name for a file, by name alone. */
export function fileIconName(path: string): string {
  const name = baseName(path).toLowerCase();
  const byName = FILENAME_ICONS[name];
  if (byName) return byName;

  const parts = name.split(".");
  if (parts.length > 2) {
    // `.spec.ts`, `.d.ts`, `.config.js` — the theme gives these their own
    // glyphs, and matching only the last extension would lose them.
    const double = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    const byDouble = EXTENSION_ICONS[double];
    if (byDouble) return byDouble;
  }
  if (parts.length > 1) {
    const byExt = EXTENSION_ICONS[parts[parts.length - 1]!];
    if (byExt) return byExt;
  }
  // A dotfile with no extension (`.gitignore` handled above, `.foorc` not) has
  // its name as its only extension.
  if (name.startsWith(".")) {
    const byDot = EXTENSION_ICONS[name.slice(1)];
    if (byDot) return byDot;
  }
  return DEFAULT_FILE_ICON;
}

/** The icon name for a folder, open or closed. */
export function folderIconName(path: string, open = false): string {
  const name = baseName(path).toLowerCase();
  const table = open ? FOLDER_OPEN_ICONS : FOLDER_ICONS;
  return table[name] ?? (open ? DEFAULT_FOLDER_OPEN_ICON : DEFAULT_FOLDER_ICON);
}

export type FileIconKind = "file" | "directory";

export interface FileIconProps {
  /** File or folder name; a whole path is fine, only the last segment is read. */
  name: string;
  kind?: FileIconKind;
  /** Directories only — the expanded glyph. */
  open?: boolean;
  className?: string;
}

/**
 * `size-4` by default, which is the size the trees and tab strips use. Pass a
 * `size-*` class to override — the span has no intrinsic size, so a caller that
 * passes none gets nothing visible.
 *
 * `inline-block` is load-bearing: `width`/`height` do not apply to a
 * non-replaced inline element, so a bare `<span class="size-4">` measures 0×0
 * wherever its parent is not a flex container. The trees are flex rows and
 * blockify it for free; the tab strip wraps its icon in a `<span class="relative">`
 * for the notification dot, and there the icon simply did not render — the one
 * place an inline `<svg>` would have worked without saying so.
 */
export function FileIcon({ name, kind = "file", open, className }: FileIconProps) {
  const icon = kind === "directory" ? folderIconName(name, open) : fileIconName(name);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block shrink-0 size-4 bg-center bg-no-repeat bg-contain",
        `vsi-${icon}`,
        className,
      )}
    />
  );
}

/**
 * The same icon as a zero-prop component, for the `icon: ElementType` slots the
 * tab bar and the command palette already have.
 *
 * Cached by name because React treats a *component type* as identity: a fresh
 * arrow function per render would unmount and remount the node on every
 * keystroke in the palette's filter.
 */
const elementCache = new Map<string, FC<{ className?: string }>>();

export function fileIconElement(
  name: string,
  kind: FileIconKind = "file",
): FC<{ className?: string }> {
  const key = `${kind}:${name}`;
  const cached = elementCache.get(key);
  if (cached) return cached;
  const Bound: FC<{ className?: string }> = ({ className }) => (
    <FileIcon name={name} kind={kind} className={className} />
  );
  Bound.displayName = `FileIcon(${name})`;
  // The palette indexes whole repositories, so this is bounded like any other
  // per-path cache in the app.
  if (elementCache.size > 500) elementCache.clear();
  elementCache.set(key, Bound);
  return Bound;
}
