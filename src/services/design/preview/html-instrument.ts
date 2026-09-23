import { parse, type DefaultTreeAdapterMap } from "parse5";

/**
 * Serve-time instrumentation of a design's HTML.
 *
 * Every element whose start tag is in the source gets `data-ppm-id="<offset>"`, where the
 * offset is the index of its `<` in the (BOM-less) source text. The offset *is* the id: it
 * lets a later write find the element's tag in the file without re-serialising anything,
 * and it is only meaningful together with the file's `gen`.
 *
 * The attribute is spliced in right after the tag name, so it is always the element's
 * first attribute — a stale `data-ppm-id` copied into the file loses to it, because the
 * HTML parser keeps the first of two duplicate attributes. The source is never
 * re-serialised; only these insertions change.
 *
 * parse5 offsets are UTF-16 code-unit indices into exactly the string it was given (CRLF
 * counts as two, an astral character as two), which is what `String#slice` uses. Elements
 * the parser invents (an implicit `<html>`, `<head>`, `<tbody>`) have no start tag and so no
 * id; an element cloned by the adoption agency algorithm shares its original's.
 */

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

export interface HtmlAnalysis {
  /** Sorted, unique start-tag offsets. */
  elementOffsets: number[];
  /** Where a script must go to run before any of the page's own. */
  headOffset: number;
  /** `href`s of local `<link rel=stylesheet>`, as written, in document order. */
  stylesheetHrefs: string[];
}

const isElement = (node: Node): node is Element => "tagName" in node;

function attr(el: Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

/** Relative URLs only: no scheme, no protocol-relative or root-relative path, no fragment. */
export function isLocalHref(href: string): boolean {
  const h = href.trim();
  return h !== "" && !/^[a-z][a-z0-9+.-]*:/i.test(h) && !h.startsWith("/") && !h.startsWith("\\") && !h.startsWith("#");
}

export function analyzeHtml(text: string): HtmlAnalysis {
  const doc = parse(text, { sourceCodeLocationInfo: true });
  const offsets = new Set<number>();
  const stylesheetHrefs: string[] = [];
  let doctypeEnd = 0;
  let htmlEnd: number | undefined;
  let headEnd: number | undefined;

  // Iterative, so a pathologically deep document cannot overflow the stack.
  const stack: Array<{ node: Node; inTemplate: boolean }> = [];
  for (let i = doc.childNodes.length - 1; i >= 0; i--) stack.push({ node: doc.childNodes[i]!, inTemplate: false });
  while (stack.length) {
    const { node, inTemplate } = stack.pop()!;
    if (node.nodeName === "#documentType" && node.sourceCodeLocation) doctypeEnd = node.sourceCodeLocation.endOffset;
    if (!isElement(node)) continue;
    const start = node.sourceCodeLocation?.startTag;
    if (start && text.charCodeAt(start.startOffset) === 60 /* < */) {
      offsets.add(start.startOffset);
      if (node.tagName === "html" && htmlEnd === undefined) htmlEnd = start.endOffset;
      if (node.tagName === "head" && headEnd === undefined) headEnd = start.endOffset;
    }
    if (!inTemplate && node.tagName === "link") {
      const rel = (attr(node, "rel") ?? "").toLowerCase().split(/\s+/);
      const href = attr(node, "href");
      if (rel.includes("stylesheet") && href !== undefined && isLocalHref(href)) stylesheetHrefs.push(href.trim());
    }
    const children = node.tagName === "template"
      ? (node as DefaultTreeAdapterMap["template"]).content.childNodes
      : node.childNodes;
    const childInTemplate = inTemplate || node.tagName === "template";
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i]!, inTemplate: childInTemplate });
  }
  return {
    elementOffsets: [...offsets].sort((a, b) => a - b),
    headOffset: headEnd ?? htmlEnd ?? doctypeEnd,
    stylesheetHrefs,
  };
}

export const elementStartOffsets = (text: string): number[] => analyzeHtml(text).elementOffsets;
export const headInsertOffset = (text: string): number => analyzeHtml(text).headOffset;
export const localStylesheetHrefs = (text: string): string[] => analyzeHtml(text).stylesheetHrefs;

/** Index just past the tag name of the start tag at `offset` (the tokenizer's own stop set). */
export function tagNameEnd(text: string, offset: number): number {
  let i = offset + 1;
  while (i < text.length && !/[\t\n\f\r />]/.test(text[i]!)) i++;
  return i;
}

/** Splice ids and the bridge into `text`. `analysis` must come from this same text. */
export function instrumentHtml(text: string, bridgeTag: string, analysis: HtmlAnalysis = analyzeHtml(text)): string {
  const inserts: Array<[number, string]> = analysis.elementOffsets.map((o) => [tagNameEnd(text, o), ` data-ppm-id="${o}"`]);
  inserts.push([analysis.headOffset, bridgeTag]);
  inserts.sort((a, b) => a[0] - b[0]);
  const out: string[] = [];
  let cursor = 0;
  for (const [at, snippet] of inserts) {
    out.push(text.slice(cursor, at), snippet);
    cursor = at;
  }
  out.push(text.slice(cursor));
  return out.join("");
}

/**
 * The bridge alone, for documents too large to parse: after a leading doctype, so the page
 * stays out of quirks mode, and otherwise at the very start.
 */
export function injectWithoutParsing(text: string, bridgeTag: string): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(text);
  const at = doctype ? doctype[0].length : 0;
  return text.slice(0, at) + bridgeTag + text.slice(at);
}
