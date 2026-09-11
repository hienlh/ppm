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
import { basename, cn } from "@/lib/utils";
import { fileIconName, folderIconName } from "./file-icon-name";
import { useIconFramework } from "@/stores/project-framework-store";

export { fileIconName, folderIconName };

/**
 * The artwork is fetched when something first asks for an icon, not before.
 *
 * Imported at module scope it was not lazy in any useful sense: this module is
 * reached from `tab-type-icons.ts`, which the tab bar, the mobile nav and the
 * dock header all import eagerly, so Vite hoisted the stylesheet into a
 * `<link rel="stylesheet">` in `index.html` — render-blocking on every load,
 * measured at 499,375 bytes raw / 127,333 gzip / 79,836 brotli. The app's
 * entire other stylesheet is 25,956 gzip, so the icons were 4.9x everything
 * else put together, in front of the first paint.
 *
 * A dynamic import makes it its own chunk with a `<link>` injected at runtime.
 * The cost is honest and visible: an icon that renders before the stylesheet
 * lands is a correctly-sized blank span for one round trip, so icons pop in a
 * beat after the text. That is the trade — paint the app now and the artwork
 * shortly, rather than neither until half a megabyte arrives — and a session
 * that never lists a file now never fetches it at all.
 *
 * Called from render rather than an effect because the point is to start the
 * fetch at the earliest moment anything wants an icon; it is idempotent and
 * touches no state, so a double invocation under StrictMode costs nothing.
 */
let cssRequested = false;
function requestIconCss(): void {
  if (cssRequested) return;
  cssRequested = true;
  void import("@/styles/file-icons.generated.css");
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
 *
 * The framework overlay is read here rather than threaded through as a prop
 * because there are eight call sites and two of them — the tab bar and the
 * command palette — go through `fileIconElement`, which hands out a *component*
 * and has no project in scope at all. The subscription costs nothing: the tree
 * is virtualised, so only the ~40 visible rows are mounted, and `TreeRow`
 * already reads four stores.
 */
export function FileIcon({ name, kind = "file", open, className }: FileIconProps) {
  requestIconCss();
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
 * Cached because React treats a *component type* as identity: a fresh arrow
 * function per render would unmount and remount the node on every keystroke in
 * the palette's filter.
 *
 * Keyed by the *basename*, not the whole path, because the basename is all
 * `fileIconName` reads. A path key made `src/a/index.ts` and `src/b/index.ts`
 * two entries rendering the same span, so a repository indexed by the palette
 * had as many keys as it had files — which is why the key needed an eviction
 * rule at all. It cannot be keyed by the resolved glyph: `FileIcon` subscribes
 * to the project's framework preset, so the glyph a name resolves to changes
 * under it and a precomputed one would stop following.
 *
 * Eviction drops the oldest quarter rather than calling `clear()`. A `Map`
 * keeps insertion order, and clearing hands every caller a new component type
 * at once — remounting every icon on screen, which is the one thing this cache
 * exists to prevent.
 */
const ELEMENT_CACHE_MAX = 2000;
const elementCache = new Map<string, FC<{ className?: string }>>();

export function fileIconElement(
  name: string,
  kind: FileIconKind = "file",
): FC<{ className?: string }> {
  // The palette asks for hundreds of these before any of them renders, so the
  // fetch starts here too rather than waiting for the first mount.
  requestIconCss();
  const base = basename(name).toLowerCase();
  const key = `${kind}:${base}`;
  const cached = elementCache.get(key);
  if (cached) return cached;
  const Bound: FC<{ className?: string }> = ({ className }) => (
    <FileIcon name={name} kind={kind} className={className} />
  );
  Bound.displayName = `FileIcon(${base})`;
  if (elementCache.size >= ELEMENT_CACHE_MAX) {
    for (const stale of [...elementCache.keys()].slice(0, ELEMENT_CACHE_MAX >> 2)) {
      elementCache.delete(stale);
    }
  }
  elementCache.set(key, Bound);
  return Bound;
}
