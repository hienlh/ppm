/**
 * Taking `class` and `style` away from whoever wrote a PPM Assistant message.
 *
 * Both are presentation the author should not get to choose. `style` is a CSS value, and
 * React receives it after `style-to-js` has stripped CSS comments, so a comment splitting the
 * word `url` becomes a working `url(` that no text test on the raw attribute can see — a fetch
 * with no click. And either one can lay the message over
 * the page: `position:fixed;inset:0;opacity:0` on a link, or the same as Tailwind classes,
 * makes the next click anywhere — an Allow button included — follow the author's URL.
 *
 * What cannot go is the presentation PPM's own pipeline writes: a fenced block's
 * `language-*`, remark-math's `math-display`, the footnote label's `sr-only`, and everything
 * KaTeX lays maths out with. So the two plugins here tell the two apart by provenance, not by
 * value. The first runs before `rehype-raw` and stamps every element the Markdown parser made
 * with a nonce no author can guess; the second runs after it and before KaTeX, and strips
 * `class` and `style` from every element without the stamp — i.e. every element that came
 * from raw HTML. The stamp is an attribute because `rehype-raw` rebuilds the tree through an
 * HTML parser and keeps attributes, not node identity or `data`.
 */

interface HastNode {
  type: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

interface VFileLike {
  data: Record<string, unknown>;
}

/** hast name of the stamp; as an attribute, `data-ppm-markdown-origin`. */
const STAMP = "dataPpmMarkdownOrigin";
/** Where the first plugin leaves this run's nonce for the second. */
const NONCE_KEY = "ppmMarkdownOriginNonce";

/** `crypto.getRandomValues`, not `randomUUID`: the latter is missing on an insecure origin. */
function freshNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function eachElement(node: HastNode, visit: (el: HastNode) => void): void {
  if (node.type === "element") visit(node);
  for (const child of node.children ?? []) eachElement(child, visit);
}

/** Before `rehype-raw`: stamps every element the Markdown parser produced. */
export function rehypeStampMarkdownElements() {
  return (tree: HastNode, file: VFileLike) => {
    const nonce = freshNonce();
    file.data[NONCE_KEY] = nonce;
    eachElement(tree, (el) => { el.properties = { ...el.properties, [STAMP]: nonce }; });
  };
}

/**
 * After `rehype-raw`, before KaTeX: drops `class` and `style` from every element that does
 * not carry this run's stamp, then removes the stamp. With no nonce (the first plugin did not
 * run) nothing is trusted, so everything is stripped rather than nothing.
 */
export function rehypeStripAuthorPresentation() {
  return (tree: HastNode, file: VFileLike) => {
    const nonce = file.data[NONCE_KEY];
    eachElement(tree, (el) => {
      const props = el.properties;
      if (!props) return;
      const fromMarkdown = typeof nonce === "string" && props[STAMP] === nonce;
      delete props[STAMP];
      if (fromMarkdown) return;
      delete props.className;
      delete props.style;
    });
  };
}
