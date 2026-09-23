import type { BridgeApi } from "./bridge-core.ts";
import type { CommentQuote } from "../../../shared/design-comment-types.ts";
import type { PickedElement } from "../../../shared/design-bridge-messages-picker.ts";

/**
 * What the canvas knows about one element: its anchor (id, tag, CSS path, text quote) and,
 * for a picked element, its box, a trimmed copy of its markup and its text.
 *
 * Every function here is shipped into the design frame as source (`toString()`, installed
 * as `ppm.lib.*` by the assembly), so none may reference anything in this module's scope:
 * helpers are written inline, and other lib functions are reached through `ppm.lib`.
 *
 * {@link elementQuote} is also what the server runs over a parse5 tree to re-validate a
 * re-anchor, which is why it walks through a {@link TreeAccess} instead of the DOM API:
 * the quote a pin was stored with and the quote of a candidate must be computed the same
 * way on both sides, or no candidate would ever score as the same element.
 */

export interface TreeAccess<N> {
  parent(node: N): N | null;
  children(node: N): ArrayLike<N>;
  /** The text of a text node; null for anything else. */
  text(node: N): string | null;
  /** The lowercase tag name of an element; null for anything else. */
  tag(node: N): string | null;
}

export interface ElementAnchorInfo {
  ppmId: number | null;
  tag: string;
  cssPath: string;
  quote: CommentQuote;
}

/**
 * The element's own text (up to 160 chars) plus up to 32 chars of the text before and after
 * it, whitespace-collapsed. The context is taken from siblings, climbing at most six
 * ancestors and never past `<body>`; script, style, template and noscript text is ignored.
 */
export function elementQuote<N>(el: N, acc: TreeAccess<N>): CommentQuote {
  const EXACT = 160;
  const SIDE = 32;
  const skip: Record<string, boolean> = { script: true, style: true, template: true, noscript: true };
  const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

  // Text of a subtree read from one end, stopping once `want` collapsed chars are in hand.
  function collect(node: N, want: number, fromEnd: boolean): string {
    const t = acc.text(node);
    if (t !== null) {
      const cap = want * 2 + 64;
      return t.length <= cap ? t : fromEnd ? t.slice(-cap) : t.slice(0, cap);
    }
    const tag = acc.tag(node);
    if (tag === null || skip[tag]) return "";
    const kids = acc.children(node);
    let out = "";
    for (let k = 0; k < kids.length; k++) {
      const part = collect(kids[fromEnd ? kids.length - 1 - k : k]!, want, fromEnd);
      out = fromEnd ? part + out : out + part;
      if (norm(out).length >= want) break;
    }
    // Element boundaries read as a space, so a heading and the paragraph after it do not
    // run together; collapsing makes it harmless inside inline markup.
    return " " + out + " ";
  }

  function side(before: boolean): string {
    let out = "";
    let cur: N = el;
    for (let depth = 0; depth < 6; depth++) {
      const parent = acc.parent(cur);
      if (parent === null) break;
      const kids = acc.children(parent);
      const at = Array.prototype.indexOf.call(kids, cur);
      if (at < 0) break;
      for (let i = before ? at - 1 : at + 1; before ? i >= 0 : i < kids.length; i += before ? -1 : 1) {
        const part = collect(kids[i]!, SIDE, before);
        out = before ? part + out : out + part;
        if (norm(out).length >= SIDE) break;
      }
      const tag = acc.tag(parent);
      if (norm(out).length >= SIDE || tag === null || tag === "body" || tag === "head" || tag === "html") break;
      cur = parent;
    }
    const n = norm(out);
    return before ? n.slice(-SIDE) : n.slice(0, SIDE);
  }

  return { exact: norm(collect(el, EXACT, false)).slice(0, EXACT), prefix: side(true), suffix: side(false) };
}

/** A {@link TreeAccess} over the live DOM. */
export function domTreeAccess(): TreeAccess<Node> {
  return {
    parent: (n) => n.parentNode,
    children: (n) => n.childNodes,
    text: (n) => (n.nodeType === 3 ? n.nodeValue || "" : null),
    tag: (n) => (n.nodeType === 1 ? (n as Element).localName.toLowerCase() : null),
  };
}

/**
 * `#id` when the element (or an ancestor, at most six levels up) has a plain, unique id,
 * otherwise a `tag:nth-of-type(n)` chain from `body`. Used only to break ties.
 */
export function cssPathOf(el: Element): string {
  const plainId = /^[A-Za-z][\w-]{0,63}$/;
  const doc = el.ownerDocument;
  const parts: string[] = [];
  let cur: Element | null = el;
  for (let depth = 0; cur && depth < 6; depth++) {
    const tag = cur.localName.toLowerCase();
    if (tag === "html") break;
    const id = cur.getAttribute("id");
    if (id && plainId.test(id) && doc.querySelectorAll("#" + id).length === 1) {
      parts.unshift("#" + id);
      break;
    }
    if (tag === "body") {
      parts.unshift("body");
      break;
    }
    let n = 1;
    for (let s = cur.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === cur.localName) n++;
    parts.unshift(tag + ":nth-of-type(" + n + ")");
    cur = cur.parentElement;
  }
  return parts.join(" > ");
}

/** The anchor fields of a live element. Ids come from the serve-time `data-ppm-id`. */
export function anchorOf(el: Element, ppm: BridgeApi): ElementAnchorInfo {
  const raw = el.getAttribute("data-ppm-id");
  const id = raw !== null && /^\d{1,10}$/.test(raw) ? parseInt(raw, 10) : NaN;
  return {
    ppmId: Number.isFinite(id) && id <= 0x7fffffff ? id : null,
    tag: el.localName.toLowerCase(),
    cssPath: ppm.lib.cssPathOf(el),
    quote: ppm.lib.elementQuote<Node>(el, ppm.lib.domTreeAccess()),
  };
}

/**
 * Everything the parent shows about a picked element. The markup is a depth-2 copy with
 * long text cut, built in an inert document so copying an `<img>` fetches nothing.
 */
export function describeElement(el: Element, ppm: BridgeApi): PickedElement {
  const anchor = ppm.lib.anchorOf(el, ppm);
  const box = el.getBoundingClientRect();
  const inert = ppm.doc.implementation.createHTMLDocument("");
  function copy(node: Node, depth: number): Node {
    if (node.nodeType === 3) {
      const t = node.nodeValue || "";
      return inert.createTextNode(t.length > 80 ? t.slice(0, 80) + "…" : t);
    }
    if (node.nodeType !== 1) return inert.createTextNode("");
    const clone = inert.importNode(node, false) as Element;
    clone.removeAttribute("data-ppm-id");
    const kids = node.childNodes;
    if (depth < 2) {
      for (let i = 0; i < kids.length && i < 20; i++) clone.appendChild(copy(kids[i]!, depth + 1));
      if (kids.length > 20) clone.appendChild(inert.createTextNode("…"));
    } else if (kids.length) {
      clone.appendChild(inert.createTextNode("…"));
    }
    return clone;
  }
  const gen = /^[0-9a-f]{16}$/.test(ppm.boot.gen) ? ppm.boot.gen : null;
  return {
    ppmId: anchor.ppmId,
    gen,
    file: ppm.boot.file,
    tag: anchor.tag,
    rect: { x: box.left, y: box.top, w: box.width, h: box.height },
    cssPath: anchor.cssPath,
    outerHtml: (copy(el, 0) as Element).outerHTML.slice(0, 2000),
    text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500),
    quote: anchor.quote,
  };
}
