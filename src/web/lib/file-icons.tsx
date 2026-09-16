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
// `?url` gives the built stylesheet's address without putting it on the module
// graph: nothing is fetched until the `<link>` below is appended.
import ICON_CSS_URL from "@/styles/file-icons.generated.css?url";
import { basename, cn } from "@/lib/utils";
import {
  DEFAULT_FILE_ICON,
  DEFAULT_FOLDER_ICON,
  DEFAULT_FOLDER_OPEN_ICON,
  EXTENSION_ICONS,
  FILENAME_ICONS,
  FOLDER_ICONS,
  FOLDER_OPEN_ICONS,
} from "./file-icons.generated";

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

/** The icon name for a file, by name alone. */
export function fileIconName(path: string): string {
  const name = basename(path).toLowerCase();
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
  const name = basename(path).toLowerCase();
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
function iconClass(icon: string, className?: string): string {
  return cn(
    "inline-block shrink-0 size-4 bg-center bg-no-repeat bg-contain",
    `vsi-${icon}`,
    className,
  );
}

export function FileIcon({ name, kind = "file", open, className }: FileIconProps) {
  requestIconCss();
  const icon = kind === "directory" ? folderIconName(name, open) : fileIconName(name);
  return <span aria-hidden="true" className={iconClass(icon, className)} />;
}

/**
 * The same icon as a zero-prop component, for the `icon: ElementType` slots the
 * tab bar and the command palette already have.
 *
 * Cached because React treats a *component type* as identity: a fresh arrow
 * function per render would unmount and remount the node on every keystroke in
 * the palette's filter.
 *
 * Keyed by the resolved glyph rather than by the path that resolved to it. A
 * path key is wrong twice over: `src/a/index.ts` and `src/b/index.ts` are two
 * entries rendering the same span, and a repository indexed by the palette has
 * as many keys as it has files — which is why the old key needed an eviction
 * rule, and why that rule was `clear()`, remounting every icon on screen at the
 * 501st distinct path. There are 224 glyphs, so keying on those makes the cache
 * bounded by construction and eviction unnecessary.
 */
const elementCache = new Map<string, FC<{ className?: string }>>();

export function fileIconElement(
  name: string,
  kind: FileIconKind = "file",
): FC<{ className?: string }> {
  // The palette asks for hundreds of these before any of them renders, so the
  // fetch starts here too rather than waiting for the first mount.
  requestIconCss();
  const icon = kind === "directory" ? folderIconName(name) : fileIconName(name);
  const cached = elementCache.get(icon);
  if (cached) return cached;
  const Bound: FC<{ className?: string }> = ({ className }) => (
    <span aria-hidden="true" className={iconClass(icon, className)} />
  );
  Bound.displayName = `FileIcon(${icon})`;
  elementCache.set(icon, Bound);
  return Bound;
}
