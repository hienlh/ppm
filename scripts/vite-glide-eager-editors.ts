/**
 * Glide's cell editors, imported up front instead of through `React.lazy`.
 *
 * Glide 6.0.3 renders its overlay editor (and the number editor inside it) lazily, so the first
 * edit after a load suspends — and React 19 then holds the editor back for its 300 ms fallback
 * throttle even when the file is already in: measured 306 ms from the key that opened it to the
 * editor taking the focus, against 5 ms on the next edit. Every key typed in between lands on the
 * grid, which takes each letter as the start of a new edit and Enter as a move, so the first edit
 * of a load, typed at an ordinary pace, kept only its last letter or nothing at all. Imported
 * statically, nothing suspends; the two files are 20 KB together, in a chunk loaded only with the
 * grid.
 *
 * Build only: `bun dev:web` pre-bundles Glide, which this hook never sees.
 */
import type { Plugin } from "vite";

/** `const X = React.lazy(async () => await import("./x.js"));`, as Glide's build writes it. */
const LAZY = /^const (\w+) = React\.lazy\(async \(\) => await import\(("[^"]+")\)\);$/gm;

/** `code` with each lazy editor imported statically, or null when the module is not Glide's or has none. */
export function eagerGlideEditors(code: string, id: string): string | null {
  if (!id.replaceAll("\\", "/").includes("/@glideapps/glide-data-grid/dist/esm/")) return null;
  const eager = code.replace(LAZY, "import $1 from $2;");
  return eager === code ? null : eager;
}

export function glideEagerEditors(): Plugin {
  return {
    name: "ppm-glide-eager-editors",
    apply: "build",
    transform(code, id) {
      const eager = eagerGlideEditors(code, id);
      // One line for one line, so nothing below it moves.
      return eager === null ? null : { code: eager, map: null };
    },
  };
}
