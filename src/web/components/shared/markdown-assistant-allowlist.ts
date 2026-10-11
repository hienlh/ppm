/**
 * What PPM Assistant Markdown may render: an allowlist of elements and attributes, per
 * namespace.
 *
 * It is an allowlist because "attributes that fetch" cannot be enumerated: an SVG animation
 * (`<set attributeName="href" to=…>`) writes a URL into an element *after* render, every SVG
 * presentation attribute is a CSS value that may name `url(…)`, and MathML accepts `href` on
 * any element. So HTML gets the elements Markdown and KaTeX produce plus common inline
 * formatting; SVG gets a static drawing subset (what KaTeX draws roots, arrows and strikes with);
 * MathML gets presentation markup only. Anything else is unwrapped (HTML) or dropped (SVG,
 * MathML, where unwrapping foreign content has no sensible text to keep).
 *
 * Names are compared lowercased: hast camel-cases known attributes (`colSpan`, `viewBox`,
 * `strokeWidth`) and passes unknown ones through as written (`displaystyle`).
 */

export type MarkupSpace = "html" | "svg" | "math";

const set = (...names: string[]) => new Set(names.map((n) => n.toLowerCase()));

const HTML_ELEMENTS = set(
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "em", "b", "i", "u", "s", "strike", "del", "ins", "mark", "small", "big", "sub", "sup",
  "code", "pre", "kbd", "samp", "var", "tt", "blockquote", "q", "cite", "dfn", "abbr", "time",
  "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
  "a", "img", "input", "span", "div", "section", "article", "aside", "header", "footer", "nav", "main",
  "address", "figure", "figcaption", "details", "summary", "ruby", "rt", "rp", "bdi", "bdo", "wbr",
);

/** Allowed on every HTML element. `style` is checked separately for anything that can fetch. */
const HTML_GLOBAL_ATTRIBUTES = set("className", "id", "title", "lang", "dir", "align", "role", "style");

const HTML_ELEMENT_ATTRIBUTES: Record<string, Set<string>> = {
  a: set("href"),
  img: set("src", "alt", "width", "height"),
  // Only a GFM task-list checkbox survives: an `<input type=image>` loads its `src`.
  input: set("type", "checked", "disabled"),
  ol: set("start", "reversed", "type"),
  li: set("value"),
  td: set("colSpan", "rowSpan", "scope", "abbr"),
  th: set("colSpan", "rowSpan", "scope", "abbr"),
  col: set("span"),
  colgroup: set("span"),
  details: set("open"),
  time: set("dateTime"),
};

/** A static drawing subset: shapes, groups and text alternatives — no references, no animation. */
const SVG_ELEMENTS = set("svg", "g", "path", "line", "rect", "circle", "ellipse", "polyline", "polygon", "title", "desc");

const SVG_ATTRIBUTES = set(
  "xmlns", "className", "style", "role", "width", "height", "viewBox", "preserveAspectRatio",
  "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "d", "points", "transform",
  "fill", "fillOpacity", "fillRule", "clipRule", "opacity", "vectorEffect",
  "stroke", "strokeWidth", "strokeOpacity", "strokeLinecap", "strokeLinejoin",
  "strokeDasharray", "strokeDashoffset", "strokeMiterlimit",
);

/** Presentation MathML. `annotation-xml` is left out: it can carry HTML or SVG back in. */
const MATHML_ELEMENTS = set(
  "math", "semantics", "annotation", "mrow", "mi", "mn", "mo", "ms", "mtext", "mspace",
  "msub", "msup", "msubsup", "mfrac", "msqrt", "mroot", "mstyle", "mpadded", "mphantom", "menclose",
  "munder", "mover", "munderover", "mtable", "mtr", "mtd", "mlabeledtr", "merror",
  "mmultiscripts", "mprescripts", "none", "mfenced",
);

const MATHML_ATTRIBUTES = set(
  "xmlns", "className", "style", "display", "encoding", "mathvariant", "mathsize", "mathcolor", "mathbackground",
  "displaystyle", "scriptlevel", "stretchy", "fence", "separator", "separators", "open", "close",
  "lspace", "rspace", "minsize", "maxsize", "largeop", "movablelimits", "symmetric", "form",
  "accent", "accentunder", "linethickness", "notation", "width", "height", "depth", "voffset",
  "columnalign", "columnspacing", "columnlines", "rowalign", "rowspacing", "rowlines",
  "frame", "framespacing", "equalrows", "equalcolumns", "side", "rowspan", "columnspan",
);

/**
 * Attributes whose value the browser parses as CSS, where `url(…)` (or an escape spelling it)
 * would fetch. Their values are checked even though the attribute itself is allowed.
 */
const CSS_VALUED_ATTRIBUTES = set(
  "style", "fill", "stroke", "transform", "mathcolor", "mathbackground",
  "fillOpacity", "strokeOpacity", "opacity", "strokeDasharray",
);

/** CSS that can reach the network: `url(`, `image-set(`, `image(`, `@import`, or any escape that could spell them. */
const FETCHING_CSS = /\\|url|image|@import|expression/i;

/** Whether an element of `tag` may be rendered in `space`. */
export function isAllowedElement(space: MarkupSpace, tag: string): boolean {
  const name = tag.toLowerCase();
  if (space === "svg") return SVG_ELEMENTS.has(name);
  if (space === "math") return MATHML_ELEMENTS.has(name);
  return HTML_ELEMENTS.has(name);
}

/** Whether hast property `prop` with `value` may stay on a `tag` element in `space`. */
export function isAllowedAttribute(space: MarkupSpace, tag: string, prop: string, value: unknown): boolean {
  const name = prop.toLowerCase();
  // Checked on the hast name, not the lowercased one: `dataFootnoteRef` is `data-footnote-ref`,
  // while a bare `data` (an `<object>`'s source) or `datasrc` is not a data attribute.
  const isAriaOrData = /^(aria|data)[A-Z]/.test(prop);
  let allowed: boolean;
  if (space === "svg") allowed = SVG_ATTRIBUTES.has(name) || isAriaOrData;
  else if (space === "math") allowed = MATHML_ATTRIBUTES.has(name) || isAriaOrData;
  else allowed = HTML_GLOBAL_ATTRIBUTES.has(name) || isAriaOrData || Boolean(HTML_ELEMENT_ATTRIBUTES[tag.toLowerCase()]?.has(name));
  if (!allowed) return false;
  if (CSS_VALUED_ATTRIBUTES.has(name) && typeof value === "string" && FETCHING_CSS.test(value)) return false;
  return true;
}
