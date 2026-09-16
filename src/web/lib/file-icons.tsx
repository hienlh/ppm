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
// `?url` gives the built stylesheet's address without putting it on the module
// graph: nothing is fetched until the `<link>` below is appended.
import ICON_CSS_URL from "@/styles/file-icons.generated.css?url";
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
 * `<link rel="stylesheet">` in `index.html` — render-blocking on every load.
 * Re-measured against this branch's full 1193-glyph port rather than the 224 it
 * was first written for: **1,952,181 bytes raw / 535,335 gzip / 391,418 brotli**
 * against the app's entire other stylesheet at 26,340 gzip, so the icons are
 * **20x** everything else put together. (The figure quoted here used to be
 * 499,375 raw / 4.9x, which was the truth at 224 glyphs and is a quarter of the
 * truth now.) It is a first-*use* cost rather than a first-load one, which is
 * the whole point of the boundary — but a phone that opens one file listing
 * downloads 382 KiB of artwork to do it, and that number belongs in the comment
 * rather than in someone's memory.
 *
 * So it is fetched at runtime by a `<link>` this function appends. The cost is
 * honest and visible: an icon that renders before the stylesheet lands is a
 * correctly-sized blank span for one round trip, so icons pop in a beat after
 * the text. That is the trade — paint the app now and the artwork shortly,
 * rather than neither until half a megabyte arrives — and a session that never
 * lists a file never fetches it at all.
 *
 * A `<link>` rather than `import()`, which is what this used to be: a dynamic
 * import that fails dispatches `vite:preloadError`, and `chunk-recovery.ts`
 * answers that by purging the asset caches and reloading the page — a path that
 * deliberately steps around the unsaved-work guard, because a missing *code*
 * chunk means the app cannot run. A missing icon sheet means the icons are
 * unstyled. A tunnel flap while someone scrolls a file tree must not reload the
 * app out from under them, and `.catch()` would not have helped: the event is
 * dispatched whether or not the promise is handled.
 *
 * Called from render rather than an effect because the point is to start the
 * fetch at the earliest moment anything wants an icon; it is idempotent and
 * touches no state, so a double invocation under StrictMode costs nothing.
 */
let cssPending = false;
let cssAttempts = 0;
function requestIconCss(): void {
  // Two attempts, not one: a tab left open through a network blip would
  // otherwise show unstyled icons for the rest of its life. Not unlimited,
  // because every icon that mounts comes through here.
  if (cssPending || cssAttempts >= 2 || typeof document === "undefined") return;
  cssPending = true;
  cssAttempts++;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = ICON_CSS_URL;
  link.addEventListener("error", () => {
    link.remove();
    cssPending = false;
  });
  document.head.appendChild(link);
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
 *
 * Insertion order, not recency: this is deliberately *not* an LRU, and the
 * difference is visible exactly once. Scrolling back through a tree with more
 * than 2000 distinct basenames can evict a name that is still on screen —
 * whichever was cached first, however recently it was used — and remount those
 * icons one time. Re-entering them puts them back at the end of the order.
 * Keeping a real LRU would mean touching the Map on every `fileIconElement`
 * call, which the palette makes hundreds of per keystroke, to avoid one
 * remount in a tree that size.
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
