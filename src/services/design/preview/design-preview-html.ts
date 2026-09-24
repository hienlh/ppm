import { posix } from "node:path";
import { readDesignFileSafe } from "../design-safe-walk.ts";
import { decodeDesignText, MAX_DESIGN_SOURCE_BYTES, readDesignSource, type DesignSource } from "../source/design-source-file.ts";
import { bridgeTag } from "../bridge/bridge-script.ts";
import { analyzeHtml, injectWithoutParsing, instrumentHtml } from "./html-instrument.ts";
import { resolveScopedPath, type ScopedAsset } from "./design-preview-scope.ts";
import type { DesignRef } from "./design-preview-tokens.ts";

/**
 * The body the preview route sends for one design HTML file.
 *
 * A canvas load gets element ids and the bridge. A file over {@link INSTRUMENT_MAX_BYTES},
 * or one that is not valid UTF-8 (whose offsets could never be written back safely), gets
 * the bridge alone and reports `instrumented: false`, so the canvas still hears `ready` and
 * only the features that need ids switch off. Print and standalone loads get no bridge and
 * no ids; `inject` (the print view's style and script) goes where the bridge would.
 */

export const INSTRUMENT_MAX_BYTES = 5 * 1024 * 1024;
/** Local stylesheets whose gen travels with `ready`; more than this is not a real design. */
const MAX_LINKED_STYLESHEETS = 32;

export interface RenderedDesignHtml {
  body: string;
  gen: string;
  instrumented: boolean;
}

/**
 * Gen of every local stylesheet the page links, keyed by its path in the design folder.
 * The shared `../tokens.css` is left out on purpose: nothing the canvas writes may target
 * it, because a change there restyles every design in the project.
 */
export async function linkedStylesheetGens(design: DesignRef, htmlRel: string, hrefs: string[]): Promise<Record<string, string>> {
  const gens: Record<string, string> = {};
  const baseDir = posix.dirname(htmlRel);
  for (const href of hrefs.slice(0, MAX_LINKED_STYLESHEETS)) {
    let rel: string;
    try {
      rel = posix.normalize(posix.join(baseDir, decodeURIComponent(href.split(/[?#]/)[0]!)));
    } catch {
      continue;
    }
    if (rel === ".." || rel.startsWith("../") || rel.startsWith("/")) continue;
    try {
      const asset = await resolveScopedPath(design, `${design.slug}/${rel}`);
      if (gens[asset.rel]) continue;
      gens[asset.rel] = (await readDesignSource(asset.abs, { lossy: true, maxBytes: INSTRUMENT_MAX_BYTES })).gen;
    } catch {
      // Missing, refused or oversized: the page cannot load it either, so there is no gen to guard.
    }
  }
  return gens;
}

/** `snippet` at the head insertion point, or after the doctype when the file is too big to parse. */
function injectPlain(text: string, snippet: string): string {
  if (text.length <= INSTRUMENT_MAX_BYTES) {
    try {
      const at = analyzeHtml(text).headOffset;
      return text.slice(0, at) + snippet + text.slice(at);
    } catch {
      // Unparseable: fall through to the position that needs no parse.
    }
  }
  return injectWithoutParsing(text, snippet);
}

export async function renderDesignHtml(
  design: DesignRef,
  asset: ScopedAsset,
  opts: { nonce: string | null; withBridge: boolean; inject?: string },
): Promise<RenderedDesignHtml> {
  const bytes = await readDesignFileSafe(asset.abs, MAX_DESIGN_SOURCE_BYTES);
  let source: DesignSource;
  let utf8 = true;
  try {
    source = decodeDesignText(bytes);
  } catch {
    source = decodeDesignText(bytes, { lossy: true });
    utf8 = false;
  }
  const { text, gen } = source;
  if (!opts.withBridge) return { body: opts.inject ? injectPlain(text, opts.inject) : text, gen, instrumented: false };

  const tag = (instrumented: boolean, cssGens: Record<string, string>): string =>
    bridgeTag({ nonce: opts.nonce, gen, cssGens, file: asset.rel, instrumented });
  if (utf8 && bytes.byteLength <= INSTRUMENT_MAX_BYTES) {
    try {
      const analysis = analyzeHtml(text);
      const cssGens = await linkedStylesheetGens(design, asset.rel, analysis.stylesheetHrefs);
      return { body: instrumentHtml(text, tag(true, cssGens), analysis), gen, instrumented: true };
    } catch (e) {
      console.warn(`[design-preview] instrumenting ${design.slug}/${asset.rel} failed: ${(e as Error).message}`);
    }
  }
  return { body: injectWithoutParsing(text, tag(false, {})), gen, instrumented: false };
}
