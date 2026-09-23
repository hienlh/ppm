import { parse, type DefaultTreeAdapterMap } from "parse5";
import { isLocalHref } from "../preview/html-instrument.ts";

/**
 * Where an HTML page's styles come from, in document (= cascade) order: its `<style>`
 * blocks as text-content offsets into the source, and its local `<link rel=stylesheet>`
 * hrefs. Offsets are parse5's, UTF-16 indices into exactly the text given (see
 * `html-instrument.ts`), so a slice of the source is the CSS the browser reads.
 *
 * Left out, because the browser does not apply them: anything inside `<template>`, a
 * `<style>` whose `type` is not CSS, and alternate or `disabled` stylesheet links. A
 * `media` attribute other than `all` makes the whole sheet conditional.
 */

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

export type HtmlStyleNode =
  | { kind: "inline"; start: number; end: number; conditional: boolean }
  | { kind: "linked"; href: string; conditional: boolean };

const isElement = (node: Node): node is Element => "tagName" in node;
const attr = (el: Element, name: string): string | undefined => el.attrs.find((a) => a.name === name)?.value;

function conditionalMedia(el: Element): boolean {
  const media = (attr(el, "media") ?? "").trim().toLowerCase();
  return media !== "" && media !== "all";
}

function walk(text: string, visit: (el: Element) => void): void {
  const doc = parse(text, { sourceCodeLocationInfo: true });
  // Iterative, so a pathologically deep document cannot overflow the stack.
  const stack: Node[] = [...doc.childNodes].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    if (!isElement(node) || node.tagName === "template") continue;
    visit(node);
    for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]!);
  }
}

export function htmlStyleNodes(html: string): HtmlStyleNode[] {
  const out: HtmlStyleNode[] = [];
  walk(html, (el) => {
    const loc = el.sourceCodeLocation;
    if (el.tagName === "style" && loc?.startTag) {
      const type = (attr(el, "type") ?? "").trim().toLowerCase();
      if (type !== "" && type !== "text/css") return;
      const start = loc.startTag.endOffset;
      // Style text is raw: without a `</style>` it runs to the end of the document.
      out.push({ kind: "inline", start, end: loc.endTag?.startOffset ?? html.length, conditional: conditionalMedia(el) });
    } else if (el.tagName === "link") {
      const rel = (attr(el, "rel") ?? "").toLowerCase().split(/\s+/);
      const href = attr(el, "href");
      if (!rel.includes("stylesheet") || rel.includes("alternate") || attr(el, "disabled") !== undefined) return;
      if (href !== undefined && isLocalHref(href)) out.push({ kind: "linked", href: href.trim(), conditional: conditionalMedia(el) });
    }
  });
  return out;
}

/** Text-content offsets of every applied `<style>` element, in document order. */
export function findStyleBlocks(html: string): Array<{ start: number; end: number }> {
  return htmlStyleNodes(html).flatMap((n) => (n.kind === "inline" ? [{ start: n.start, end: n.end }] : []));
}

/**
 * Where a new `<style>` element goes so it lands last in `<head>`: before `</head>`, else
 * after the `<head>` start tag, else before `<body>`, else after `<html>` or the doctype.
 */
export function headEndOffset(html: string): number {
  let head: Element | undefined, body: Element | undefined, root: Element | undefined;
  walk(html, (el) => {
    if (el.tagName === "head" && !head) head = el;
    else if (el.tagName === "body" && !body) body = el;
    else if (el.tagName === "html" && !root) root = el;
  });
  const h = head?.sourceCodeLocation;
  if (h?.endTag) return h.endTag.startOffset;
  if (h?.startTag) return h.startTag.endOffset;
  const b = body?.sourceCodeLocation?.startTag;
  if (b) return b.startOffset;
  const r = root?.sourceCodeLocation?.startTag;
  if (r) return r.endOffset;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? doctype[0].length : 0;
}
