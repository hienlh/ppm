import { parse, type DefaultTreeAdapterMap } from "parse5";
import { elementQuote, type TreeAccess } from "../bridge/bridge-element-info.ts";
import type { CommentQuote } from "../../../shared/design-comment-types.ts";

/**
 * The source text of the element whose start tag is at `ppmId` (a `data-ppm-id`), read
 * from the file itself rather than from anything the page reported.
 *
 * The range runs from the `<` of the start tag to the end of the end tag (or of the last
 * child, when the end tag is implied; a void element is just its start tag). The quote is
 * computed by the same `elementQuote` the canvas uses, over the parse5 tree, so a stored
 * quote and a source quote are comparable. `text` must be the BOM-less text the gen and the
 * ids were computed over (`readDesignSource`).
 */

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];

export interface ElementSourceRange {
  start: number;
  end: number;
  tag: string;
  /** The element's collapsed text, up to the quote's 160 chars. */
  textContent: string;
  quote: CommentQuote;
}

const isElement = (node: Node): node is Element => "tagName" in node;

const PARSE5_ACCESS: TreeAccess<Node> = {
  parent: (n) => ((n as { parentNode?: ParentNode | null }).parentNode ?? null) as Node | null,
  children: (n) => ("childNodes" in n ? (n as ParentNode).childNodes : []),
  text: (n) => (n.nodeName === "#text" ? (n as DefaultTreeAdapterMap["textNode"]).value : null),
  tag: (n) => (isElement(n) ? n.tagName.toLowerCase() : null),
};

export function findByStartOffset(root: Node, offset: number): Element | null {
  // Iterative, so a pathologically deep document cannot overflow the stack.
  const stack: Node[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (isElement(node)) {
      const start = node.sourceCodeLocation?.startTag?.startOffset;
      if (start === offset) return node;
      if (node.tagName === "template") stack.push((node as DefaultTreeAdapterMap["template"]).content);
    }
    if ("childNodes" in node) {
      const kids = (node as ParentNode).childNodes;
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
    }
  }
  return null;
}

export function elementSourceRange(text: string, ppmId: number): ElementSourceRange | null {
  if (!Number.isInteger(ppmId) || ppmId < 0 || ppmId >= text.length || text.charCodeAt(ppmId) !== 60 /* < */) return null;
  const doc = parse(text, { sourceCodeLocationInfo: true });
  const el = findByStartOffset(doc, ppmId);
  const loc = el?.sourceCodeLocation;
  if (!el || !loc?.startTag) return null;
  const end = Math.max(loc.startTag.endOffset, loc.endTag?.endOffset ?? loc.endOffset);
  const quote = elementQuote<Node>(el, PARSE5_ACCESS);
  return { start: ppmId, end, tag: el.tagName.toLowerCase(), textContent: quote.exact, quote };
}
