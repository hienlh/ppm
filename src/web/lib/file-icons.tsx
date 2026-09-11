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
 * Name resolution is next door in `file-icon-name.ts`, which is pure and
 * testable; this file is the drawing and the one subscription that decides
 * whether `.service.ts` is a Nest provider or an Angular service.
 * `fileIconElement` is for the slots that want a component rather than an
 * element — the tab bar and the palette both take an `icon: ElementType`.
 */
import type { FC } from "react";
import { cn } from "@/lib/utils";
import { fileIconName, folderIconName } from "./file-icon-name";
import { useIconFramework } from "@/stores/project-framework-store";
import "@/styles/file-icons.generated.css";

export { fileIconName, folderIconName };

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
 *
 * The framework overlay is read here rather than threaded through as a prop
 * because there are eight call sites and two of them — the tab bar and the
 * command palette — go through `fileIconElement`, which hands out a *component*
 * and has no project in scope at all. The subscription costs nothing: the tree
 * is virtualised, so only the ~40 visible rows are mounted, and `TreeRow`
 * already reads four stores.
 */
export function FileIcon({ name, kind = "file", open, className }: FileIconProps) {
  const framework = useIconFramework();
  const icon = kind === "directory" ? folderIconName(name, open) : fileIconName(name, framework);
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
