import { posix } from "node:path";
import { resolveScopedPath, TOKENS_CSS_ALIAS } from "../preview/design-preview-scope.ts";
import type { DesignRef } from "../preview/design-preview-tokens.ts";
import { readDesignSource, type DesignSource } from "./design-source-file.ts";
import { htmlStyleNodes } from "./html-style-blocks.ts";

/**
 * The stylesheets one design page is styled by, in cascade order, read from disk.
 *
 * Inline `<style>` blocks and local `<link rel=stylesheet>` files, in document order —
 * which is the order in which a later `:root` declaration beats an earlier one. CDN sheets
 * are skipped (not ours to read or write), as are links the canvas cannot load either:
 * missing files, anything outside the design folder except the shared `tokens.css`, and
 * non-`.css` targets. `tokens.css` stays in the list, marked `outside`, because a variable
 * it sets last really does win on screen — the tweak commit refuses that case rather than
 * patching a declaration that would lose to it.
 */

/** Local stylesheets considered per page; the preview reports gens for the same number. */
export const MAX_LINKED_STYLE_SOURCES = 32;

export interface StyleSource {
  /** Design-relative path of the file holding the CSS; `../tokens.css` for the shared one. */
  file: string;
  kind: "inline" | "linked";
  /** Offsets of the CSS text inside the file's (BOM-less) text; the whole file when linked. */
  start: number;
  end: number;
  /** A `media` attribute limits the whole sheet. */
  conditional: boolean;
  /** Outside the design folder: part of the cascade, never written. */
  outside: boolean;
}

export interface StyleFile {
  abs: string;
  source: DesignSource;
  outside: boolean;
}

export interface DesignStyleSources {
  entry: StyleFile;
  sources: StyleSource[];
  /** Every file read, keyed like {@link StyleSource.file}; the entry HTML included. */
  files: Map<string, StyleFile>;
}

/** The design-relative path an href names, or null when it cannot be one of the design's files. */
export function linkedStylePath(entryRel: string, href: string): string | null {
  let rel: string;
  try {
    rel = posix.normalize(posix.join(posix.dirname(entryRel), decodeURIComponent(href.split(/[?#]/)[0]!)));
  } catch {
    return null;
  }
  if (!/\.css$/i.test(rel)) return null;
  if (rel === `../${TOKENS_CSS_ALIAS}`) return rel;
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("/")) return null;
  return rel;
}

async function readLinked(design: DesignRef, rel: string): Promise<{ rel: string; file: StyleFile } | null> {
  const outside = rel.startsWith("../");
  let asset: { abs: string; rel: string };
  try {
    asset = await resolveScopedPath(design, outside ? TOKENS_CSS_ALIAS : `${design.slug}/${rel}`);
  } catch {
    // Missing, or refused by the preview's own guard: the canvas does not load it, so it is not in the cascade.
    return null;
  }
  // Keyed by the scope's own relative path, which is also how the preview names it in `cssGens`.
  return { rel: asset.rel, file: { abs: asset.abs, source: await readDesignSource(asset.abs), outside } };
}

export async function styleSources(design: DesignRef, entryRel: string): Promise<DesignStyleSources> {
  const entryAbs = (await resolveScopedPath(design, `${design.slug}/${entryRel}`)).abs;
  const entry: StyleFile = { abs: entryAbs, source: await readDesignSource(entryAbs), outside: false };
  const files = new Map<string, StyleFile>([[entryRel, entry]]);
  const sources: StyleSource[] = [];
  let linked = 0;

  for (const node of htmlStyleNodes(entry.source.text)) {
    if (node.kind === "inline") {
      sources.push({ file: entryRel, kind: "inline", start: node.start, end: node.end, conditional: node.conditional, outside: false });
      continue;
    }
    if (linked >= MAX_LINKED_STYLE_SOURCES) continue;
    const path = linkedStylePath(entryRel, node.href);
    if (!path) continue;
    linked++;
    const read = await readLinked(design, path);
    if (!read || read.rel === entryRel) continue;
    const { rel } = read;
    const file = files.get(rel) ?? read.file;
    files.set(rel, file);
    sources.push({
      file: rel, kind: "linked", start: 0, end: file.source.text.length, conditional: node.conditional, outside: file.outside,
    });
  }
  return { entry, sources, files };
}
