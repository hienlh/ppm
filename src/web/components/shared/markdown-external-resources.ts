/**
 * Keeping a model's Markdown from making the browser fetch anything on its own.
 *
 * Chat Markdown renders raw HTML and loads images, and a page that loads `https://x/?k=…`
 * has sent `…` to `x` — no click, no approval. For the PPM Assistant, which reads
 * untrusted content (other chats, database rows, terminals) and holds secrets in its
 * context, that is an exfiltration channel. This rehype plugin rewrites the tree so nothing
 * outside PPM is requested until the user clicks a link:
 *
 * - an external image becomes a link to it;
 * - embeds (iframe, video, audio, object, picture…) become links to what they would load;
 * - `<script>`, `<style>`, `<link>`, `<meta>`, `<base>` are dropped outright;
 * - any other attribute that names an external resource (`srcset`, `poster`, SVG `href`,
 *   `background`…) is removed, and so is an inline `style` that could fetch (`url(`, any
 *   CSS escape, `image-set`…). KaTeX's own layout styles carry none of those, so maths
 *   still renders.
 *
 * "External" is anything the browser would fetch from another origin. Local file paths
 * are loaded through PPM's own API by `MdImage`, and `data:`/`blob:` never leave the page.
 */

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
}

/** Elements that only exist to load something; never rendered in assistant content. */
const DROP_TAGS = new Set(["script", "style", "link", "meta", "base", "noscript", "template"]);
/** Elements that load media or documents; replaced by links to what they would load. */
const EMBED_TAGS = new Set(["iframe", "frame", "frameset", "embed", "object", "applet", "portal", "video", "audio", "picture", "source", "track"]);
/** Attributes (hast property names) the browser fetches from without a click. */
const URL_PROPS = ["src", "srcSet", "href", "xLinkHref", "poster", "data", "background", "lowsrc", "dynsrc", "codeBase", "archive", "manifest", "icon"];
/** CSS that can reach the network: `url(`, `image-set(`, `image(`, `@import`, or any escape that could spell them. */
const FETCHING_STYLE = /\\|url|image|@import|expression/i;

/**
 * Whether the browser would fetch `raw` from somewhere other than PPM itself.
 *
 * Tabs and newlines are removed first and surrounding controls trimmed, because the URL
 * parser does the same: `ht\ntps://x` loads `https://x`, and `/\x` is `//x`.
 */
export function isExternalResourceUrl(raw: string): boolean {
  const url = raw.replace(/[\t\n\r]/g, "").replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");
  if (!url) return false;
  if (/^[\\/]{2}/.test(url)) return true;
  if (/^[a-z]:[\\/]/i.test(url)) return false;
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (!scheme) return false;
  return scheme !== "data" && scheme !== "blob";
}

function urlsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

/** Every URL a `srcset` names (the first token of each candidate). */
function srcsetUrls(value: unknown): string[] {
  return urlsOf(value).flatMap((v) => v.split(",").map((c) => c.trim().split(/\s+/)[0] ?? "").filter(Boolean));
}

/** External URLs an element and its descendants would load. */
function collectExternalUrls(node: HastNode, out: string[] = []): string[] {
  for (const prop of URL_PROPS) {
    const values = prop === "srcSet" ? srcsetUrls(node.properties?.[prop]) : urlsOf(node.properties?.[prop]);
    for (const url of values) if (isExternalResourceUrl(url) && !out.includes(url)) out.push(url);
  }
  for (const child of node.children ?? []) if (child.type === "element") collectExternalUrls(child, out);
  return out;
}

const text = (value: string): HastNode => ({ type: "text", value });

/** A link the user may choose to follow — or, inside a link already, just its label. */
function linkTo(url: string, label: string, insideLink: boolean): HastNode {
  if (insideLink) return { type: "element", tagName: "span", properties: { title: url }, children: [text(label)] };
  return {
    type: "element", tagName: "a",
    properties: { href: url, title: `Not loaded automatically: ${url}` },
    children: [text(label)],
  };
}

function blockedEmbed(node: HastNode, insideLink: boolean): HastNode {
  const kind = node.tagName ?? "content";
  const urls = collectExternalUrls(node);
  const children: HastNode[] = [text(`[${kind} not loaded`)];
  urls.forEach((url, i) => { children.push(text(i === 0 ? ": " : ", "), linkTo(url, url, insideLink)); });
  children.push(text("]"));
  return { type: "element", tagName: "span", properties: { className: ["md-blocked-resource"] }, children };
}

function stripProperties(node: HastNode, keepHref: boolean): void {
  const props = node.properties;
  if (!props) return;
  delete props.ping;
  if (typeof props.style === "string" && FETCHING_STYLE.test(props.style)) delete props.style;
  for (const prop of URL_PROPS) {
    if (prop === "href" && keepHref) continue;
    const values = prop === "srcSet" ? srcsetUrls(props[prop]) : urlsOf(props[prop]);
    if (values.some(isExternalResourceUrl)) delete props[prop];
  }
}

function sanitize(node: HastNode, insideLink: boolean): HastNode | null {
  if (node.type !== "element") return node;
  const tag = (node.tagName ?? "").toLowerCase();
  if (DROP_TAGS.has(tag)) return null;
  if (EMBED_TAGS.has(tag)) return blockedEmbed(node, insideLink);
  if (tag === "img") {
    const src = typeof node.properties?.src === "string" ? node.properties.src : "";
    if (src && isExternalResourceUrl(src)) {
      const alt = typeof node.properties?.alt === "string" && node.properties.alt ? node.properties.alt : src;
      return linkTo(src, `Image: ${alt}`, insideLink);
    }
  }
  const isLink = tag === "a" || tag === "area";
  stripProperties(node, isLink);
  if (node.children) node.children = sanitizeChildren(node.children, insideLink || tag === "a");
  return node;
}

function sanitizeChildren(children: HastNode[], insideLink: boolean): HastNode[] {
  const out: HastNode[] = [];
  for (const child of children) {
    const next = sanitize(child, insideLink);
    if (next) out.push(next);
  }
  return out;
}

/** Rehype plugin: see the file comment. Mutates the tree in place, as rehype plugins do. */
export function rehypeBlockExternalResources() {
  return (tree: HastNode) => {
    if (tree.children) tree.children = sanitizeChildren(tree.children, false);
  };
}
