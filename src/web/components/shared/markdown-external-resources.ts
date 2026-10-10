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
 * - everything else is held to an allowlist (`markdown-assistant-allowlist.ts`): known
 *   elements keep only known attributes, an unknown HTML element is replaced by its text,
 *   SVG is limited to static shapes and MathML to presentation markup, and a CSS-valued
 *   attribute (`style`, `fill`…) that could fetch (`url(`, any CSS escape, `image-set`…) is
 *   removed. KaTeX's own spans, SVG and MathML fit inside it, so maths still renders.
 *
 * "External" is anything the browser would fetch from another origin. Local file paths
 * are loaded through PPM's own API by `MdImage`, and `data:`/`blob:` never leave the page.
 */
import { isAllowedAttribute, isAllowedElement, type MarkupSpace } from "./markdown-assistant-allowlist";

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
/** Attributes (hast property names) an embed may name what it loads with; offered back as links. */
const URL_PROPS = ["src", "srcSet", "href", "xLinkHref", "poster", "data", "background", "lowsrc", "dynsrc", "codeBase", "archive", "manifest", "icon"];

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

/** Removes every property the allowlist does not keep for this element. */
function keepAllowedProperties(node: HastNode, space: MarkupSpace, tag: string): void {
  const props = node.properties;
  if (!props) return;
  for (const [prop, value] of Object.entries(props)) {
    if (!isAllowedAttribute(space, tag, prop, value)) delete props[prop];
  }
}

/** What an element becomes: itself, its children in its place, or nothing. */
type Sanitized = HastNode | HastNode[] | null;

function sanitize(node: HastNode, insideLink: boolean, space: MarkupSpace): Sanitized {
  if (node.type !== "element") return node;
  const tag = node.tagName ?? "";
  const lower = tag.toLowerCase();
  if (DROP_TAGS.has(lower)) return null;
  if (space === "html") {
    if (EMBED_TAGS.has(lower)) return blockedEmbed(node, insideLink);
    if (lower === "svg" || lower === "math") return sanitizeElement(node, insideLink, lower);
    if (lower === "img") {
      const src = typeof node.properties?.src === "string" ? node.properties.src : "";
      if (src && isExternalResourceUrl(src)) {
        const alt = typeof node.properties?.alt === "string" && node.properties.alt ? node.properties.alt : src;
        return linkTo(src, `Image: ${alt}`, insideLink);
      }
    }
    if (lower === "input" && String(node.properties?.type ?? "").toLowerCase() !== "checkbox") return null;
    // An unknown HTML element keeps its text: `<x-widget src=…>words</x-widget>` reads as "words".
    if (!isAllowedElement("html", tag)) return sanitizeChildren(node.children ?? [], insideLink, "html");
    return sanitizeElement(node, insideLink, "html");
  }
  // Inside SVG or MathML anything off the static subset goes with its subtree: animation
  // elements carry no text, and what an island like `foreignObject` holds is the problem.
  if (!isAllowedElement(space, tag)) return null;
  return sanitizeElement(node, insideLink, space);
}

function sanitizeElement(node: HastNode, insideLink: boolean, space: MarkupSpace): HastNode {
  const tag = node.tagName ?? "";
  keepAllowedProperties(node, space, tag);
  if (node.children) node.children = sanitizeChildren(node.children, insideLink || tag.toLowerCase() === "a", space);
  return node;
}

function sanitizeChildren(children: HastNode[], insideLink: boolean, space: MarkupSpace): HastNode[] {
  const out: HastNode[] = [];
  for (const child of children) {
    const next = sanitize(child, insideLink, space);
    if (Array.isArray(next)) out.push(...next);
    else if (next) out.push(next);
  }
  return out;
}

/** Rehype plugin: see the file comment. Mutates the tree in place, as rehype plugins do. */
export function rehypeBlockExternalResources() {
  return (tree: HastNode) => {
    if (tree.children) tree.children = sanitizeChildren(tree.children, false, "html");
  };
}
