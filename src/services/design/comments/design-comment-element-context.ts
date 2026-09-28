import {
  COMMENT_LIMITS, stripHtmlComments, type CommentAnchor, type CommentQuote,
} from "../../../shared/design-comment-types.ts";
import { resolveScopedPath } from "../preview/design-preview-scope.ts";
import { readDesignSource, type DesignSource } from "../source/design-source-file.ts";
import { elementSourceRange } from "../source/element-source-range.ts";
import { diceSimilarity, resolveAnchor } from "../bridge/bridge-anchor-resolve.ts";
import { INSTRUMENT_MAX_BYTES } from "../preview/design-preview-html.ts";
import { DesignError } from "../design-error.ts";

/**
 * What a comment may say about its element, taken from the design's source file only.
 *
 * The page reports its own markup and text, and the page's scripts can make them anything
 * — including instructions aimed at the agent that will read the comment. So the snippet
 * that reaches a prompt is always sliced out of the file on disk at the element's start
 * offset, and only when the page's `gen` still matches the file (the offsets are
 * meaningless otherwise) and the tag at that offset agrees. When it does, the stored quote
 * is replaced by the source's too. A re-anchor the frame reports is held to the same
 * standard: same tag, and a quote score of at least 0.55, both computed from the source.
 */

export interface ElementContext {
  snippet: string | null;
  quote: CommentQuote;
}

/** The HTML file a comment is on: inside the design, no dot-directories, `.html`/`.htm`. */
export async function resolveCommentFile(projectPath: string, slug: string, file: string): Promise<string> {
  if (!/\.html?$/i.test(file) || file.startsWith("/") || file.split("/").includes("..")) {
    throw new DesignError(400, "EBADFILE", "A comment must be on an HTML file of the design");
  }
  return (await resolveScopedPath({ projectPath, slug }, `${slug}/${file}`)).abs;
}

export function capSnippet(markup: string): string {
  const clean = stripHtmlComments(markup);
  return clean.length <= COMMENT_LIMITS.snippet ? clean : `${clean.slice(0, COMMENT_LIMITS.snippet - 1)}…`;
}

async function readSource(abs: string): Promise<DesignSource | null> {
  try {
    return await readDesignSource(abs, { maxBytes: INSTRUMENT_MAX_BYTES });
  } catch (e) {
    // Not UTF-8 or too large to have ids: there is no source range to take, only the quote.
    if (e instanceof DesignError && e.status === 422) return null;
    if ((e as { status?: number }).status === 413) return null;
    throw e;
  }
}

export async function elementContext(projectPath: string, slug: string, anchor: CommentAnchor): Promise<ElementContext> {
  const abs = await resolveCommentFile(projectPath, slug, anchor.file);
  const source = await readSource(abs);
  if (!source || anchor.ppmId === null || anchor.gen !== source.gen) return { snippet: null, quote: anchor.quote };
  const range = elementSourceRange(source.text, anchor.ppmId);
  if (!range || range.tag !== anchor.tag) return { snippet: null, quote: anchor.quote };
  return { snippet: capSnippet(source.text.slice(range.start, range.end)), quote: range.quote };
}

/**
 * Checks that the element at `next.ppmId`, under the file's current gen, is plausibly the
 * one `stored` was made on. Returns the new snippet; throws 409 otherwise.
 */
export async function validateReanchor(
  projectPath: string,
  slug: string,
  stored: CommentAnchor,
  next: { ppmId: number; gen: string },
): Promise<string> {
  const refuse = (why: string): DesignError => new DesignError(409, "EANCHOR", `Cannot move this comment: ${why}`);
  const abs = await resolveCommentFile(projectPath, slug, stored.file);
  const source = await readSource(abs);
  if (!source || next.gen !== source.gen) throw refuse("the file has changed since the canvas loaded it");
  const range = elementSourceRange(source.text, next.ppmId);
  if (!range || range.tag !== stored.tag) throw refuse("there is no matching element at that position");
  const candidate = { ppmId: next.ppmId, tag: range.tag, cssPath: "", quote: range.quote };
  const verdict = resolveAnchor({ ...stored, ppmId: null }, [candidate], source.gen, diceSimilarity);
  if (verdict.status !== "reanchored") throw refuse("that element's text does not match the comment's");
  return capSnippet(source.text.slice(range.start, range.end));
}
